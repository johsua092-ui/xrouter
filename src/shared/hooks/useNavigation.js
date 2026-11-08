"use client";

import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { filterNavigation, hasMediaNew as mediaHasNew, DEFAULT_PERMISSIONS } from "@/shared/constants/navigation";
import useSettingsStore from "@/store/settingsStore";

/* Shared navigation state: identity, permissions, translator flag, and the
   filtered item lists. Both the right rail and the mobile nav consume this,
   so gating logic lives in exactly one place. */

export function useNavigation() {
  const pathname = usePathname();
  const [authStatus, setAuthStatus] = useState(null);
  const [enableTranslator, setEnableTranslator] = useState(false);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((res) => res.json())
      .then((data) => setAuthStatus(data))
      .catch(() => {});
  }, []);

  const isApiKeyUser = authStatus?.role === "apikey";
  const permissions = authStatus?.permissions || DEFAULT_PERMISSIONS;

  useEffect(() => {
    if (isApiKeyUser) return;
    let alive = true;
    useSettingsStore
      .getState()
      .fetchSettings()
      .then((data) => {
        if (alive && data?.enableTranslator) setEnableTranslator(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isApiKeyUser]);

  const filtered = filterNavigation({ isApiKeyUser, permissions, enableTranslator });

  const isActive = (href) => {
    if (href === '/dashboard') return pathname === '/dashboard';
    if (href === "/dashboard/endpoint") {
      return pathname.startsWith("/dashboard/endpoint");
    }
    return pathname.startsWith(href);
  };

  return { ...filtered, isApiKeyUser, permissions, hasMediaNew: mediaHasNew, isActive, pathname };
}
