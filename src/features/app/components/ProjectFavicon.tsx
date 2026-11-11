import { useEffect, useState } from "react";
import { resolveProjectFavicon } from "@services/tauri";

type ProjectFaviconProps = {
  website?: string | null;
};

export function projectFaviconUrl(website?: string | null): string | null {
  if (!website?.trim()) {
    return null;
  }

  try {
    const url = new URL(website.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }

    return new URL("/favicon.ico", url).toString();
  } catch {
    return null;
  }
}

export function ProjectFavicon({ website }: ProjectFaviconProps) {
  const fallbackUrl = projectFaviconUrl(website);
  const [faviconUrl, setFaviconUrl] = useState(fallbackUrl);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    setFaviconUrl(fallbackUrl);
    setUnavailable(false);
    if (!fallbackUrl || !website) {
      return () => { active = false; };
    }

    void resolveProjectFavicon(website).then((url) => {
      if (active && url) {
        setFaviconUrl(url);
      }
    }).catch(() => undefined);

    return () => { active = false; };
  }, [fallbackUrl, website]);

  if (!faviconUrl || unavailable) {
    return null;
  }

  return (
    <img
      className="project-favicon"
      src={faviconUrl}
      alt=""
      aria-hidden="true"
      onError={() => setUnavailable(true)}
    />
  );
}
