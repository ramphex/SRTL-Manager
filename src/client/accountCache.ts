import type { QueryClient } from "@tanstack/react-query";
import type { AuthMe } from "../shared/auth";

export const signedOutState: AuthMe = { authenticated: false, setupRequired: false, user: null };

// Whose data the cache holds: the signed-in account's id, null when nobody is signed in, undefined while unknown.
export function cacheAccount(me: AuthMe | undefined): number | null | undefined {
  if (!me) return undefined;
  return me.authenticated ? me.user?.id ?? null : null;
}

// Forgets everything loaded or sent for the previous account, keeping only the session check itself.
export function clearAccountData(queryClient: QueryClient): void {
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "me" });
}

// After a sign-out the app shows the sign-in screen at once, then confirms with the server.
export function showSignedOut(queryClient: QueryClient): Promise<void> {
  queryClient.setQueryData(["me"], signedOutState);
  return queryClient.invalidateQueries({ queryKey: ["me"] });
}
