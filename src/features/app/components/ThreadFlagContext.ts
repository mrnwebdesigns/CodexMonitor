import { createContext, useContext } from "react";

type ThreadFlagContextValue = {
  isThreadFlagged: (workspaceId: string, threadId: string) => boolean;
};

export const ThreadFlagContext = createContext<ThreadFlagContextValue>({
  isThreadFlagged: () => false,
});

export function useThreadFlagged(workspaceId: string, threadId: string): boolean {
  return useContext(ThreadFlagContext).isThreadFlagged(workspaceId, threadId);
}
