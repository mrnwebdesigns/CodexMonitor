import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject } from "react";
import * as Sentry from "@sentry/react";
import type {
  AppMention,
  ComposerSendIntent,
  RateLimitSnapshot,
  CustomPromptOption,
  DebugEntry,
  ReviewTarget,
  SendMessageResult,
  ServiceTier,
  ThreadTokenUsage,
  UsageGovernorQueueItem,
  UsageGovernorSettings,
  WorkspaceInfo,
} from "@/types";
import {
  compactThread as compactThreadService,
  sendUserMessage as sendUserMessageService,
  steerTurn as steerTurnService,
  startReview as startReviewService,
  interruptTurn as interruptTurnService,
  getAppsList as getAppsListService,
  listMcpServerStatus as listMcpServerStatusService,
} from "@services/tauri";
import { expandCustomPromptText } from "@utils/customPrompts";
import {
  asString,
  extractReviewThreadId,
  extractRpcErrorMessage,
  parseReviewTarget,
} from "@threads/utils/threadNormalize";
import type { ThreadAction, ThreadState } from "./useThreadsReducer";
import { useReviewPrompt } from "./useReviewPrompt";
import {
  buildAppsLines,
  buildMcpStatusLines,
  buildReviewThreadTitle,
  buildStatusLines,
  buildTurnStartPayload,
  isStaleSteerTurnError,
  parseFastCommand,
  resolveSendMessageOptions,
  type SendMessageOptions,
} from "./threadMessagingHelpers";
import {
  appendUsageRateSample,
  buildUsageGovernorSnapshot,
  DEFAULT_USAGE_GOVERNOR_SETTINGS,
  selectWeeklyRateLimit,
  type UsageRateSample,
} from "@/features/usage/usageGovernor";

type UseThreadMessagingOptions = {
  activeWorkspace: WorkspaceInfo | null;
  activeThreadId: string | null;
  accessMode?: "read-only" | "current" | "full-access";
  model?: string | null;
  effort?: string | null;
  serviceTier?: ServiceTier | null | undefined;
  collaborationMode?: Record<string, unknown> | null;
  onSelectServiceTier?: (tier: ServiceTier | null | undefined) => void;
  reviewDeliveryMode?: "inline" | "detached";
  steerEnabled: boolean;
  customPrompts: CustomPromptOption[];
  ensureWorkspaceRuntimeCodexArgs?: (
    workspaceId: string,
    threadId: string | null,
  ) => Promise<void>;
  shouldPreflightRuntimeCodexArgsForSend?: (
    workspaceId: string,
    threadId: string,
  ) => boolean;
  threadStatusById: ThreadState["threadStatusById"];
  activeTurnIdByThread: ThreadState["activeTurnIdByThread"];
  rateLimitsByWorkspace: Record<string, RateLimitSnapshot | null>;
  tokenUsageByThread?: Record<string, ThreadTokenUsage>;
  workspaceIdByThread?: Record<string, string>;
  usageGovernor?: UsageGovernorSettings;
  pendingInterruptsRef: MutableRefObject<Set<string>>;
  dispatch: Dispatch<ThreadAction>;
  getCustomName: (workspaceId: string, threadId: string) => string | undefined;
  markProcessing: (threadId: string, isProcessing: boolean) => void;
  markReviewing: (threadId: string, isReviewing: boolean) => void;
  setActiveTurnId: (threadId: string, turnId: string | null) => void;
  recordThreadActivity: (
    workspaceId: string,
    threadId: string,
    timestamp?: number,
  ) => void;
  safeMessageActivity: () => void;
  onDebug?: (entry: DebugEntry) => void;
  pushThreadErrorMessage: (threadId: string, message: string) => void;
  ensureThreadForActiveWorkspace: () => Promise<string | null>;
  ensureThreadForWorkspace: (workspaceId: string) => Promise<string | null>;
  refreshThread: (workspaceId: string, threadId: string) => Promise<string | null>;
  forkThreadForWorkspace: (
    workspaceId: string,
    threadId: string,
    options?: { activate?: boolean },
  ) => Promise<string | null>;
  updateThreadParent: (parentId: string, childIds: string[]) => void;
  registerDetachedReviewChild?: (
    workspaceId: string,
    parentId: string,
    childId: string,
  ) => void;
  renameThread?: (workspaceId: string, threadId: string, name: string) => void;
};

type GovernorQueuedRequest = UsageGovernorQueueItem & {
  workspace: WorkspaceInfo;
  text: string;
  images: string[];
  options?: SendMessageOptions;
  compactionAttempted?: boolean;
};

const GOVERNOR_COMPACTION_COOLDOWN_MS = 30 * 60 * 1000;

export function useThreadMessaging({
  activeWorkspace,
  activeThreadId,
  accessMode,
  model,
  effort,
  serviceTier,
  collaborationMode,
  onSelectServiceTier,
  reviewDeliveryMode = "inline",
  steerEnabled,
  customPrompts,
  ensureWorkspaceRuntimeCodexArgs,
  shouldPreflightRuntimeCodexArgsForSend,
  threadStatusById,
  activeTurnIdByThread,
  rateLimitsByWorkspace,
  tokenUsageByThread = {},
  workspaceIdByThread = {},
  usageGovernor = { ...DEFAULT_USAGE_GOVERNOR_SETTINGS, mode: "off" },
  pendingInterruptsRef,
  dispatch,
  getCustomName,
  markProcessing,
  markReviewing,
  setActiveTurnId,
  recordThreadActivity,
  safeMessageActivity,
  onDebug,
  pushThreadErrorMessage,
  ensureThreadForActiveWorkspace,
  ensureThreadForWorkspace,
  refreshThread,
  forkThreadForWorkspace,
  updateThreadParent,
  registerDetachedReviewChild,
  renameThread,
}: UseThreadMessagingOptions) {
  const sendMessageNow = useCallback(
    async (
      workspace: WorkspaceInfo,
      threadId: string,
      text: string,
      images: string[] = [],
      options?: SendMessageOptions,
    ): Promise<SendMessageResult> => {
      const messageText = text.trim();
      if (!messageText && images.length === 0) {
        return { status: "blocked" };
      }
      let finalText = messageText;
      if (!options?.skipPromptExpansion) {
        const promptExpansion = expandCustomPromptText(messageText, customPrompts);
        if (promptExpansion && "error" in promptExpansion) {
          pushThreadErrorMessage(threadId, promptExpansion.error);
          safeMessageActivity();
          return { status: "blocked" };
        }
        finalText = promptExpansion?.expanded ?? messageText;
      }
      const isProcessing = threadStatusById[threadId]?.isProcessing ?? false;
      const activeTurnId = activeTurnIdByThread[threadId] ?? null;
      const {
        resolvedModel,
        resolvedEffort,
        resolvedServiceTier,
        sanitizedCollaborationMode,
        resolvedAccessMode,
        appMentions,
        sendIntent,
        shouldSteer,
        requestMode,
      } = resolveSendMessageOptions({
        options,
        defaults: {
          accessMode,
          model,
          effort,
          serviceTier,
          collaborationMode,
          steerEnabled,
          isProcessing,
          activeTurnId,
        },
      });
      Sentry.metrics.count("prompt_sent", 1, {
        attributes: {
          workspace_id: workspace.id,
          thread_id: threadId,
          has_images: images.length > 0 ? "true" : "false",
          text_length: String(finalText.length),
          model: resolvedModel ?? "unknown",
          effort: resolvedEffort ?? "unknown",
          service_tier: resolvedServiceTier ?? "default",
          collaboration_mode: sanitizedCollaborationMode ?? "unknown",
          send_intent: sendIntent,
        },
      });
      const timestamp = Date.now();
      const customThreadName = getCustomName(workspace.id, threadId) ?? null;
      recordThreadActivity(workspace.id, threadId, timestamp);
      dispatch({
        type: "setThreadTimestamp",
        workspaceId: workspace.id,
        threadId,
        timestamp,
      });
      markProcessing(threadId, true);
      dispatch({ type: "markUnread", threadId, hasUnread: false });
      safeMessageActivity();
      onDebug?.({
        id: `${Date.now()}-${shouldSteer ? "client-turn-steer" : "client-turn-start"}`,
        timestamp: Date.now(),
        source: "client",
        label: shouldSteer ? "turn/steer" : "turn/start",
        payload: {
          workspaceId: workspace.id,
          threadId,
          turnId: activeTurnId,
          text: finalText,
          images,
          model: resolvedModel,
          effort: resolvedEffort,
          serviceTier: resolvedServiceTier,
          collaborationMode: sanitizedCollaborationMode,
          sendIntent,
          threadCustomName: customThreadName,
        },
      });
      try {
        const shouldPreflightRuntimeCodexArgs =
          shouldPreflightRuntimeCodexArgsForSend?.(workspace.id, threadId) ?? true;
        if (
          !shouldSteer &&
          shouldPreflightRuntimeCodexArgs &&
          ensureWorkspaceRuntimeCodexArgs
        ) {
          await ensureWorkspaceRuntimeCodexArgs(workspace.id, threadId);
        }
        const response: Record<string, unknown> = shouldSteer
          ? (await (appMentions.length > 0
            ? steerTurnService(
              workspace.id,
              threadId,
              activeTurnId ?? "",
              finalText,
              images,
              appMentions,
            )
            : steerTurnService(
              workspace.id,
              threadId,
              activeTurnId ?? "",
              finalText,
              images,
            ))) as Record<string, unknown>
          : (await sendUserMessageService(
            workspace.id,
            threadId,
            finalText,
            buildTurnStartPayload({
              model: resolvedModel,
              effort: resolvedEffort,
              serviceTier: resolvedServiceTier,
              collaborationMode: sanitizedCollaborationMode,
              accessMode: resolvedAccessMode,
              images,
              appMentions,
            }),
          )) as Record<string, unknown>;

        const rpcError = extractRpcErrorMessage(response);

        onDebug?.({
          id: `${Date.now()}-${requestMode === "steer" ? "server-turn-steer" : "server-turn-start"}`,
          timestamp: Date.now(),
          source: "server",
          label: requestMode === "steer" ? "turn/steer response" : "turn/start response",
          payload: response,
        });
        if (rpcError) {
          if (requestMode !== "steer") {
            markProcessing(threadId, false);
            setActiveTurnId(threadId, null);
            pushThreadErrorMessage(threadId, `Turn failed to start: ${rpcError}`);
            safeMessageActivity();
            return { status: "blocked" };
          }
          if (isStaleSteerTurnError(rpcError)) {
            markProcessing(threadId, false);
            setActiveTurnId(threadId, null);
          }
          pushThreadErrorMessage(
            threadId,
            `Turn steer failed: ${rpcError}`,
          );
          safeMessageActivity();
          return { status: "steer_failed" };
        }
        if (requestMode === "steer") {
          const result = (response?.result ?? response) as Record<string, unknown>;
          const steeredTurnId = asString(result?.turnId ?? result?.turn_id ?? "");
          if (steeredTurnId) {
            setActiveTurnId(threadId, steeredTurnId);
          }
          return { status: "sent" };
        }
        const result = (response?.result ?? response) as Record<string, unknown>;
        const turn = (result?.turn ?? response?.turn ?? null) as
          | Record<string, unknown>
          | null;
        const turnId = asString(turn?.id ?? "");
        if (!turnId) {
          markProcessing(threadId, false);
          setActiveTurnId(threadId, null);
          pushThreadErrorMessage(threadId, "Turn failed to start.");
          safeMessageActivity();
          return { status: "blocked" };
        }
        setActiveTurnId(threadId, turnId);
        return { status: "sent" };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (requestMode !== "steer") {
          markProcessing(threadId, false);
          setActiveTurnId(threadId, null);
        } else if (isStaleSteerTurnError(errorMessage)) {
          markProcessing(threadId, false);
          setActiveTurnId(threadId, null);
        }
        onDebug?.({
          id: `${Date.now()}-${requestMode === "steer" ? "client-turn-steer-error" : "client-turn-start-error"}`,
          timestamp: Date.now(),
          source: "error",
          label: requestMode === "steer" ? "turn/steer error" : "turn/start error",
          payload: errorMessage,
        });
        pushThreadErrorMessage(
          threadId,
          requestMode === "steer"
            ? `Turn steer failed: ${errorMessage}`
            : errorMessage,
        );
        safeMessageActivity();
        return { status: requestMode === "steer" ? "steer_failed" : "blocked" };
      }
    },
    [
      accessMode,
      collaborationMode,
      customPrompts,
      dispatch,
      effort,
      serviceTier,
      ensureWorkspaceRuntimeCodexArgs,
      shouldPreflightRuntimeCodexArgsForSend,
      activeTurnIdByThread,
      getCustomName,
      markProcessing,
      model,
      onDebug,
      pushThreadErrorMessage,
      recordThreadActivity,
      safeMessageActivity,
      setActiveTurnId,
      steerEnabled,
      threadStatusById,
    ],
  );

  const [governorQueue, setGovernorQueue] = useState<GovernorQueuedRequest[]>([]);
  const [rateHistory, setRateHistory] = useState<UsageRateSample[]>([]);
  const governorStartingRef = useRef(0);
  const governorBaselineTokensRef = useRef<Record<string, number>>({});
  const governorInterruptedTurnsRef = useRef(new Set<string>());
  const governorCompactedAtRef = useRef<Record<string, number>>({});

  const activeTurnCount = useMemo(
    () =>
      Object.values(threadStatusById).filter((status) => status.isProcessing).length,
    [threadStatusById],
  );
  const weeklyRateLimit = useMemo(
    () => selectWeeklyRateLimit(Object.values(rateLimitsByWorkspace)),
    [rateLimitsByWorkspace],
  );

  useEffect(() => {
    setRateHistory((previous) =>
      appendUsageRateSample(previous, weeklyRateLimit, Date.now()),
    );
  }, [weeklyRateLimit]);

  const usageGovernorSnapshot = useMemo(
    () =>
      buildUsageGovernorSnapshot({
        settings: usageGovernor,
        rateLimits: Object.values(rateLimitsByWorkspace),
        history: rateHistory,
        activeTurns: activeTurnCount,
        queuedTurns: governorQueue.length,
        now: Date.now(),
      }),
    [
      activeTurnCount,
      governorQueue.length,
      rateHistory,
      rateLimitsByWorkspace,
      usageGovernor,
    ],
  );

  const sendMessageToThread = useCallback(
    async (
      workspace: WorkspaceInfo,
      threadId: string,
      text: string,
      images: string[] = [],
      options?: SendMessageOptions,
    ): Promise<SendMessageResult> => {
      const targetIsProcessing = threadStatusById[threadId]?.isProcessing ?? false;
      const shouldGovern =
        usageGovernor.mode === "adaptive" &&
        !targetIsProcessing &&
        activeTurnCount + governorStartingRef.current >=
          usageGovernorSnapshot.effectiveConcurrency;
      if (!shouldGovern) {
        return sendMessageNow(workspace, threadId, text, images, options);
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const position = governorQueue.length + 1;
      setGovernorQueue((previous) => [
        ...previous,
        {
          id,
          workspaceId: workspace.id,
          threadId,
          workspace,
          text,
          images,
          options,
          createdAt: Date.now(),
          position,
        },
      ]);
      dispatch({
        type: "addAssistantMessage",
        threadId,
        text: `Queued by usage governor · position ${position}.`,
      });
      safeMessageActivity();
      return { status: "queued", queueId: id, queuePosition: position };
    },
    [
      activeTurnCount,
      dispatch,
      governorQueue.length,
      safeMessageActivity,
      sendMessageNow,
      threadStatusById,
      usageGovernor.mode,
      usageGovernorSnapshot.effectiveConcurrency,
    ],
  );

  useEffect(() => {
    if (governorQueue.length === 0) return;
    const available = usageGovernor.mode === "adaptive"
      ? Math.max(
          0,
          usageGovernorSnapshot.effectiveConcurrency -
            activeTurnCount -
            governorStartingRef.current,
        )
      : governorQueue.length;
    if (available === 0) return;

    const releasing = governorQueue.slice(0, available);
    setGovernorQueue((previous) => previous.slice(releasing.length));
    governorStartingRef.current += releasing.length;
    for (const request of releasing) {
      void (async () => {
        try {
          const usage = tokenUsageByThread[request.threadId];
          const contextWindow = usage?.modelContextWindow ?? 0;
          const contextPercent =
            contextWindow > 0
              ? (usage.last.inputTokens / contextWindow) * 100
              : 0;
          const lastCompactedAt = governorCompactedAtRef.current[request.threadId] ?? 0;
          if (
            usageGovernor.autoCompactEnabled &&
            !request.compactionAttempted &&
            contextPercent >= usageGovernor.compactContextPercent &&
            Date.now() - lastCompactedAt >= GOVERNOR_COMPACTION_COOLDOWN_MS
          ) {
            governorCompactedAtRef.current[request.threadId] = Date.now();
            try {
              await compactThreadService(request.workspaceId, request.threadId);
              window.setTimeout(() => {
                setGovernorQueue((previous) => [
                  { ...request, compactionAttempted: true },
                  ...previous,
                ]);
              }, 500);
              return;
            } catch (error) {
              pushThreadErrorMessage(
                request.threadId,
                `Automatic context compaction failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
          await sendMessageNow(
            request.workspace,
            request.threadId,
            request.text,
            request.images,
            request.options,
          );
        } finally {
          governorStartingRef.current = Math.max(0, governorStartingRef.current - 1);
        }
      })();
    }
  }, [
    activeTurnCount,
    governorQueue,
    pushThreadErrorMessage,
    sendMessageNow,
    tokenUsageByThread,
    usageGovernor,
    usageGovernorSnapshot.effectiveConcurrency,
  ]);

  useEffect(() => {
    for (const [threadId, status] of Object.entries(threadStatusById)) {
      if (!status.isProcessing) {
        delete governorBaselineTokensRef.current[threadId];
        continue;
      }
      if (governorBaselineTokensRef.current[threadId] === undefined) {
        governorBaselineTokensRef.current[threadId] =
          tokenUsageByThread[threadId]?.total.totalTokens ?? 0;
      }
    }
  }, [threadStatusById, tokenUsageByThread]);

  useEffect(() => {
    if (
      usageGovernor.mode !== "adaptive" ||
      !usageGovernor.autoInterruptRunaways ||
      usageGovernorSnapshot.state === "normal" ||
      usageGovernorSnapshot.state === "off"
    ) {
      return;
    }
    const candidates = Object.entries(threadStatusById)
      .filter(([, status]) => status.isProcessing)
      .map(([threadId, status]) => {
        const total = tokenUsageByThread[threadId]?.total.totalTokens ?? 0;
        const baseline = governorBaselineTokensRef.current[threadId] ?? total;
        return {
          threadId,
          turnId: activeTurnIdByThread[threadId] ?? null,
          workspaceId: workspaceIdByThread[threadId] ?? null,
          tokens: Math.max(0, total - baseline),
          durationMs:
            status.processingStartedAt === null
              ? 0
              : Date.now() - status.processingStartedAt,
        };
      })
      .filter((candidate) => candidate.turnId && candidate.workspaceId)
      .sort((a, b) => b.tokens - a.tokens);
    const dominant = candidates[0];
    if (!dominant) return;
    const totalGrowth = candidates.reduce((sum, candidate) => sum + candidate.tokens, 0);
    const ownsMajority = totalGrowth === 0 || dominant.tokens >= totalGrowth / 2;
    const overBudget = dominant.tokens >= usageGovernor.runawayTokenBudget;
    const overTime =
      dominant.durationMs >= usageGovernor.runawayMinutes * 60_000;
    if (
      !ownsMajority ||
      (!overBudget && !overTime) ||
      governorInterruptedTurnsRef.current.has(dominant.turnId!)
    ) {
      return;
    }
    governorInterruptedTurnsRef.current.add(dominant.turnId!);
    void interruptTurnService(
      dominant.workspaceId!,
      dominant.threadId,
      dominant.turnId!,
    ).then(() => {
      markProcessing(dominant.threadId, false);
      setActiveTurnId(dominant.threadId, null);
      dispatch({
        type: "addAssistantMessage",
        threadId: dominant.threadId,
        text: "Paused by usage governor because this turn dominated recent usage while the weekly allowance was projected to run out before reset. Send Continue to resume.",
      });
      safeMessageActivity();
    }).catch(() => {
      governorInterruptedTurnsRef.current.delete(dominant.turnId!);
    });
  }, [
    activeTurnIdByThread,
    dispatch,
    markProcessing,
    safeMessageActivity,
    setActiveTurnId,
    threadStatusById,
    tokenUsageByThread,
    usageGovernor,
    usageGovernorSnapshot.state,
    workspaceIdByThread,
  ]);

  const usageGovernorQueue: UsageGovernorQueueItem[] = useMemo(
    () =>
      governorQueue.map((request, index) => ({
        id: request.id,
        workspaceId: request.workspaceId,
        threadId: request.threadId,
        createdAt: request.createdAt,
        position: index + 1,
      })),
    [governorQueue],
  );

  const cancelUsageGovernorQueueItem = useCallback((id: string) => {
    setGovernorQueue((previous) => previous.filter((request) => request.id !== id));
  }, []);

  const runUsageGovernorQueueItemNow = useCallback((id: string) => {
    const request = governorQueue.find((candidate) => candidate.id === id);
    if (!request) return;
    setGovernorQueue((previous) =>
      previous.filter((candidate) => candidate.id !== id),
    );
    governorStartingRef.current += 1;
    void sendMessageNow(
      request.workspace,
      request.threadId,
      request.text,
      request.images,
      request.options,
    ).finally(() => {
      governorStartingRef.current = Math.max(0, governorStartingRef.current - 1);
    });
  }, [governorQueue, sendMessageNow]);

  const sendUserMessage = useCallback(
    async (
      text: string,
      images: string[] = [],
      appMentions: AppMention[] = [],
      options?: { sendIntent?: ComposerSendIntent },
    ): Promise<SendMessageResult> => {
      if (!activeWorkspace) {
        return { status: "blocked" };
      }
      const messageText = text.trim();
      if (!messageText && images.length === 0) {
        return { status: "blocked" };
      }
      const promptExpansion = expandCustomPromptText(messageText, customPrompts);
      if (promptExpansion && "error" in promptExpansion) {
        if (activeThreadId) {
          pushThreadErrorMessage(activeThreadId, promptExpansion.error);
          safeMessageActivity();
        } else {
          onDebug?.({
            id: `${Date.now()}-client-prompt-expand-error`,
            timestamp: Date.now(),
            source: "error",
            label: "prompt/expand error",
            payload: promptExpansion.error,
          });
        }
        return { status: "blocked" };
      }
      const finalText = promptExpansion?.expanded ?? messageText;
      const threadId = await ensureThreadForActiveWorkspace();
      if (!threadId) {
        return { status: "blocked" };
      }
      return sendMessageToThread(activeWorkspace, threadId, finalText, images, {
        skipPromptExpansion: true,
        appMentions,
        sendIntent: options?.sendIntent,
      });
    },
    [
      activeThreadId,
      activeWorkspace,
      customPrompts,
      ensureThreadForActiveWorkspace,
      onDebug,
      pushThreadErrorMessage,
      safeMessageActivity,
      sendMessageToThread,
    ],
  );

  const sendUserMessageToThread = useCallback(
    async (
      workspace: WorkspaceInfo,
      threadId: string,
      text: string,
      images: string[] = [],
      options?: SendMessageOptions,
    ): Promise<SendMessageResult> => {
      return sendMessageToThread(workspace, threadId, text, images, options);
    },
    [sendMessageToThread],
  );

  const interruptTurn = useCallback(async () => {
    if (!activeWorkspace || !activeThreadId) {
      return;
    }
    const activeTurnId = activeTurnIdByThread[activeThreadId] ?? null;
    const turnId = activeTurnId ?? "pending";
    markProcessing(activeThreadId, false);
    setActiveTurnId(activeThreadId, null);
    dispatch({
      type: "addAssistantMessage",
      threadId: activeThreadId,
      text: "Session stopped.",
    });
    if (!activeTurnId) {
      pendingInterruptsRef.current.add(activeThreadId);
    }
    onDebug?.({
      id: `${Date.now()}-client-turn-interrupt`,
      timestamp: Date.now(),
      source: "client",
      label: "turn/interrupt",
      payload: {
        workspaceId: activeWorkspace.id,
        threadId: activeThreadId,
        turnId,
        queued: !activeTurnId,
      },
    });
    try {
      const response = await interruptTurnService(
        activeWorkspace.id,
        activeThreadId,
        turnId,
      );
      onDebug?.({
        id: `${Date.now()}-server-turn-interrupt`,
        timestamp: Date.now(),
        source: "server",
        label: "turn/interrupt response",
        payload: response,
      });
    } catch (error) {
      onDebug?.({
        id: `${Date.now()}-client-turn-interrupt-error`,
        timestamp: Date.now(),
        source: "error",
        label: "turn/interrupt error",
        payload: error instanceof Error ? error.message : String(error),
      });
    }
  }, [
    activeThreadId,
    activeTurnIdByThread,
    activeWorkspace,
    dispatch,
    markProcessing,
    onDebug,
    pendingInterruptsRef,
    setActiveTurnId,
  ]);

  const startReviewTarget = useCallback(
    async (target: ReviewTarget, workspaceIdOverride?: string): Promise<boolean> => {
      const workspaceId = workspaceIdOverride ?? activeWorkspace?.id ?? null;
      if (!workspaceId) {
        return false;
      }
      const threadId = workspaceIdOverride
        ? await ensureThreadForWorkspace(workspaceId)
        : await ensureThreadForActiveWorkspace();
      if (!threadId) {
        return false;
      }

      const lockParentThread = reviewDeliveryMode !== "detached";
      if (lockParentThread) {
        markProcessing(threadId, true);
        markReviewing(threadId, true);
        safeMessageActivity();
      }
      onDebug?.({
        id: `${Date.now()}-client-review-start`,
        timestamp: Date.now(),
        source: "client",
        label: "review/start",
        payload: {
          workspaceId,
          threadId,
          target,
        },
      });
      try {
        const response = await startReviewService(
          workspaceId,
          threadId,
          target,
          reviewDeliveryMode,
        );
        onDebug?.({
          id: `${Date.now()}-server-review-start`,
          timestamp: Date.now(),
          source: "server",
          label: "review/start response",
          payload: response,
        });
        const rpcError = extractRpcErrorMessage(response);
        if (rpcError) {
          if (lockParentThread) {
            markProcessing(threadId, false);
            markReviewing(threadId, false);
            setActiveTurnId(threadId, null);
          }
          pushThreadErrorMessage(threadId, `Review failed to start: ${rpcError}`);
          safeMessageActivity();
          return false;
        }
        const reviewThreadId = extractReviewThreadId(response);
        if (reviewThreadId && reviewThreadId !== threadId) {
          updateThreadParent(threadId, [reviewThreadId]);
          if (reviewDeliveryMode === "detached") {
            registerDetachedReviewChild?.(workspaceId, threadId, reviewThreadId);
            const reviewTitle = buildReviewThreadTitle(target);
            if (reviewTitle && !getCustomName(workspaceId, reviewThreadId)) {
              renameThread?.(workspaceId, reviewThreadId, reviewTitle);
            }
          }
        }
        return true;
      } catch (error) {
        if (lockParentThread) {
          markProcessing(threadId, false);
          markReviewing(threadId, false);
        }
        onDebug?.({
          id: `${Date.now()}-client-review-start-error`,
          timestamp: Date.now(),
          source: "error",
          label: "review/start error",
          payload: error instanceof Error ? error.message : String(error),
        });
        pushThreadErrorMessage(
          threadId,
          error instanceof Error ? error.message : String(error),
        );
        safeMessageActivity();
        return false;
      }
    },
    [
      activeWorkspace,
      ensureThreadForActiveWorkspace,
      ensureThreadForWorkspace,
      getCustomName,
      markProcessing,
      markReviewing,
      onDebug,
      pushThreadErrorMessage,
      safeMessageActivity,
      setActiveTurnId,
      reviewDeliveryMode,
      registerDetachedReviewChild,
      renameThread,
      updateThreadParent,
    ],
  );

  const {
    reviewPrompt,
    openReviewPrompt,
    closeReviewPrompt,
    showPresetStep,
    choosePreset,
    highlightedPresetIndex,
    setHighlightedPresetIndex,
    highlightedBranchIndex,
    setHighlightedBranchIndex,
    highlightedCommitIndex,
    setHighlightedCommitIndex,
    handleReviewPromptKeyDown,
    confirmBranch,
    selectBranch,
    selectBranchAtIndex,
    selectCommit,
    selectCommitAtIndex,
    confirmCommit,
    updateCustomInstructions,
    confirmCustom,
  } = useReviewPrompt({
    activeWorkspace,
    activeThreadId,
    onDebug,
    startReviewTarget,
  });

  const startReview = useCallback(
    async (text: string) => {
      if (!activeWorkspace || !text.trim()) {
        return;
      }
      const trimmed = text.trim();
      const rest = trimmed.replace(/^\/review\b/i, "").trim();
      if (!rest) {
        openReviewPrompt();
        return;
      }

      const target = parseReviewTarget(trimmed);
      await startReviewTarget(target);
    },
    [
      activeWorkspace,
      openReviewPrompt,
      startReviewTarget,
    ],
  );

  const startUncommittedReview = useCallback(
    async (workspaceId?: string | null) => {
      const workspaceOverride = workspaceId ?? undefined;
      await startReviewTarget({ type: "uncommittedChanges" }, workspaceOverride);
    },
    [startReviewTarget],
  );

  const startStatus = useCallback(
    async (_text: string) => {
      if (!activeWorkspace) {
        return;
      }
      const threadId = await ensureThreadForActiveWorkspace();
      if (!threadId) {
        return;
      }

      const lines = buildStatusLines({
        model,
        serviceTier,
        effort,
        accessMode,
        collaborationMode,
        rateLimits: rateLimitsByWorkspace[activeWorkspace.id] ?? null,
      });
      const timestamp = Date.now();
      recordThreadActivity(activeWorkspace.id, threadId, timestamp);
      dispatch({
        type: "addAssistantMessage",
        threadId,
        text: lines.join("\n"),
      });
      safeMessageActivity();
    },
    [
      accessMode,
      activeWorkspace,
      collaborationMode,
      dispatch,
      effort,
      ensureThreadForActiveWorkspace,
      model,
      serviceTier,
      rateLimitsByWorkspace,
      recordThreadActivity,
      safeMessageActivity,
    ],
  );

  const startFast = useCallback(
    async (text: string) => {
      if (!activeWorkspace) {
        return;
      }
      const threadId = await ensureThreadForActiveWorkspace();
      if (!threadId) {
        return;
      }

      const action = parseFastCommand(text);
      const isEnabled = serviceTier === "fast";
      let nextTier = serviceTier ?? null;
      let message = "";

      if (action === "invalid") {
        message = "Usage: /fast, /fast on, /fast off, or /fast status.";
      } else if (action === "status") {
        message = `Fast mode is ${isEnabled ? "on" : "off"}.`;
      } else {
        nextTier =
          action === "on"
            ? "fast"
            : action === "off"
              ? null
              : isEnabled
                ? null
                : "fast";
        onSelectServiceTier?.(nextTier);
        message = `Fast mode ${nextTier === "fast" ? "enabled" : "disabled"}.`;
      }

      const timestamp = Date.now();
      recordThreadActivity(activeWorkspace.id, threadId, timestamp);
      dispatch({
        type: "addAssistantMessage",
        threadId,
        text: message,
      });
      safeMessageActivity();
    },
    [
      activeWorkspace,
      dispatch,
      ensureThreadForActiveWorkspace,
      onSelectServiceTier,
      recordThreadActivity,
      safeMessageActivity,
      serviceTier,
    ],
  );

  const startMcp = useCallback(
    async (_text: string) => {
      if (!activeWorkspace) {
        return;
      }
      const threadId = await ensureThreadForActiveWorkspace();
      if (!threadId) {
        return;
      }

      try {
        const response = (await listMcpServerStatusService(
          activeWorkspace.id,
          null,
          null,
        )) as Record<string, unknown> | null;
        const result = (response?.result ?? response) as
          | Record<string, unknown>
          | null;
        const data = Array.isArray(result?.data)
          ? (result?.data as Array<Record<string, unknown>>)
          : [];
        const lines = buildMcpStatusLines(data);

        const timestamp = Date.now();
        recordThreadActivity(activeWorkspace.id, threadId, timestamp);
        dispatch({
          type: "addAssistantMessage",
          threadId,
          text: lines.join("\n"),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to load MCP status.";
        dispatch({
          type: "addAssistantMessage",
          threadId,
          text: `MCP tools:\n- ${message}`,
        });
      } finally {
        safeMessageActivity();
      }
    },
    [
      activeWorkspace,
      dispatch,
      ensureThreadForActiveWorkspace,
      recordThreadActivity,
      safeMessageActivity,
    ],
  );

  const startApps = useCallback(
    async (_text: string) => {
      if (!activeWorkspace) {
        return;
      }
      const threadId = await ensureThreadForActiveWorkspace();
      if (!threadId) {
        return;
      }

      try {
        const response = (await getAppsListService(
          activeWorkspace.id,
          null,
          100,
          threadId,
        )) as Record<string, unknown> | null;
        const result = (response?.result ?? response) as
          | Record<string, unknown>
          | null;
        const data = Array.isArray(result?.data)
          ? (result?.data as Array<Record<string, unknown>>)
          : [];
        const lines = buildAppsLines(data);

        const timestamp = Date.now();
        recordThreadActivity(activeWorkspace.id, threadId, timestamp);
        dispatch({
          type: "addAssistantMessage",
          threadId,
          text: lines.join("\n"),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to load apps.";
        dispatch({
          type: "addAssistantMessage",
          threadId,
          text: `Apps:\n- ${message}`,
        });
      } finally {
        safeMessageActivity();
      }
    },
    [
      activeWorkspace,
      dispatch,
      ensureThreadForActiveWorkspace,
      recordThreadActivity,
      safeMessageActivity,
    ],
  );

  const startFork = useCallback(
    async (text: string) => {
      if (!activeWorkspace || !activeThreadId) {
        return;
      }
      const trimmed = text.trim();
      const rest = trimmed.replace(/^\/fork\b/i, "").trim();
      const threadId = await forkThreadForWorkspace(activeWorkspace.id, activeThreadId);
      if (!threadId) {
        return;
      }
      updateThreadParent(activeThreadId, [threadId]);
      if (rest) {
        await sendMessageToThread(activeWorkspace, threadId, rest, []);
      }
    },
    [
      activeThreadId,
      activeWorkspace,
      forkThreadForWorkspace,
      sendMessageToThread,
      updateThreadParent,
    ],
  );

  const startResume = useCallback(
    async (_text: string) => {
      if (!activeWorkspace) {
        return;
      }
      if (activeThreadId && threadStatusById[activeThreadId]?.isProcessing) {
        return;
      }
      const threadId = activeThreadId ?? (await ensureThreadForActiveWorkspace());
      if (!threadId) {
        return;
      }
      await refreshThread(activeWorkspace.id, threadId);
      safeMessageActivity();
    },
    [
      activeThreadId,
      activeWorkspace,
      ensureThreadForActiveWorkspace,
      refreshThread,
      safeMessageActivity,
      threadStatusById,
    ],
  );

  const startCompact = useCallback(
    async (_text: string) => {
      if (!activeWorkspace) {
        return;
      }
      const threadId = activeThreadId ?? (await ensureThreadForActiveWorkspace());
      if (!threadId) {
        return;
      }
      try {
        await compactThreadService(activeWorkspace.id, threadId);
      } catch (error) {
        pushThreadErrorMessage(
          threadId,
          error instanceof Error
            ? error.message
            : "Failed to start context compaction.",
        );
      } finally {
        safeMessageActivity();
      }
    },
    [
      activeThreadId,
      activeWorkspace,
      ensureThreadForActiveWorkspace,
      pushThreadErrorMessage,
      safeMessageActivity,
    ],
  );

  return {
    interruptTurn,
    sendUserMessage,
    sendUserMessageToThread,
    usageGovernorSnapshot,
    usageGovernorQueue,
    cancelUsageGovernorQueueItem,
    runUsageGovernorQueueItemNow,
    startFork,
    startReview,
    startUncommittedReview,
    startResume,
    startCompact,
    startApps,
    startMcp,
    startFast,
    startStatus,
    reviewPrompt,
    openReviewPrompt,
    closeReviewPrompt,
    showPresetStep,
    choosePreset,
    highlightedPresetIndex,
    setHighlightedPresetIndex,
    highlightedBranchIndex,
    setHighlightedBranchIndex,
    highlightedCommitIndex,
    setHighlightedCommitIndex,
    handleReviewPromptKeyDown,
    confirmBranch,
    selectBranch,
    selectBranchAtIndex,
    selectCommit,
    selectCommitAtIndex,
    confirmCommit,
    updateCustomInstructions,
    confirmCustom,
  };
}
