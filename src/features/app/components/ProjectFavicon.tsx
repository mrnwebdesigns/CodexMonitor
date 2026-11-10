import { useEffect, useState } from "react";

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
  const faviconUrl = projectFaviconUrl(website);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    setUnavailable(false);
  }, [faviconUrl]);

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
