import { useEffect, useState } from "react";
import { resolveProjectFavicon } from "@services/tauri";
import { normalizeBrowserUrl } from "@/features/browser/utils/browserAnnotations";

type ProjectFaviconProps = {
  website?: string | null;
};

export function projectFaviconUrl(website?: string | null): string | null {
  if (!website?.trim()) {
    return null;
  }

  try {
    return new URL("/favicon.ico", normalizeBrowserUrl(website)).toString();
  } catch {
    return null;
  }
}

export function ProjectFavicon({ website }: ProjectFaviconProps) {
  const fallbackUrl = projectFaviconUrl(website);
  const [resolvedIcon, setResolvedIcon] = useState<{ website: string; url: string } | null>(null);
  const [failedUrls, setFailedUrls] = useState<string[]>([]);

  useEffect(() => {
    setResolvedIcon(null);
    setFailedUrls([]);
    if (!fallbackUrl || !website) return;

    let active = true;
    void resolveProjectFavicon(website).then((url) => {
      if (active && url) setResolvedIcon({ website, url });
    }).catch(() => undefined);

    return () => { active = false; };
  }, [fallbackUrl, website]);

  const resolvedUrl = resolvedIcon?.website === website ? resolvedIcon?.url : null;
  const faviconUrl = [resolvedUrl, fallbackUrl].find((url) => url && !failedUrls.includes(url));
  if (!faviconUrl) return null;

  return (
    <img
      key={faviconUrl}
      className="project-favicon"
      src={faviconUrl}
      alt=""
      aria-hidden="true"
      onError={() => setFailedUrls((previous) => [...previous, faviconUrl])}
    />
  );
}
