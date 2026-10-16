"use client";

import { useI18n } from "@/lib/i18n-react";
import { hardNavigate } from "@/lib/hard-nav";

export function SignOutButtons({ signedIn }: { signedIn: boolean }) {
  const { t } = useI18n();
  return (
    <div className="zv-stack">
      {signedIn && (
        <button
          type="button"
          className="zv-btn zv-btn-primary zv-btn-lg zv-btn-block"
          onClick={() => void fetch("/api/auth/logout", { method: "POST" }).finally(() => hardNavigate("/"))}
        >
          {t("nav.signout")}
        </button>
      )}
      <a className="zv-btn zv-btn-lg zv-btn-block" href={signedIn ? "/home" : "/"}>
        {t("nav.home")}
      </a>
    </div>
  );
}
