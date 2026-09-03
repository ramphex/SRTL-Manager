export const pwaUpdateReadyEvent = "srtl:pwa-update-ready";
export const pwaRegistrationErrorEvent = "srtl:pwa-registration-error";

const serviceWorkerPath = "/service-worker.js";
const cachePrefix = "srtl-static-";
const activateUpdateMessage = "SRTL_ACTIVATE_UPDATE";
const notifiedWorkers = new WeakSet<ServiceWorker>();
let pendingUpdateRegistration: ServiceWorkerRegistration | null = null;
const productionBuild = (import.meta as ImportMeta & { readonly env?: { readonly PROD?: boolean } }).env?.PROD === true;

export interface PwaUpdateReadyDetail {
  registration: ServiceWorkerRegistration;
}

export interface PwaRegistrationErrorDetail {
  error: unknown;
}

export interface ActivatablePwaRegistration {
  waiting: { postMessage: (message: unknown) => void } | null;
}

function dispatchRegistrationError(error: unknown): void {
  window.dispatchEvent(new CustomEvent<PwaRegistrationErrorDetail>(pwaRegistrationErrorEvent, { detail: { error } }));
}

function dispatchUpdateReady(registration: ServiceWorkerRegistration, worker: ServiceWorker): void {
  if (notifiedWorkers.has(worker)) return;
  notifiedWorkers.add(worker);
  pendingUpdateRegistration = registration;
  window.dispatchEvent(new CustomEvent<PwaUpdateReadyDetail>(pwaUpdateReadyEvent, { detail: { registration } }));
}

function watchForUpdates(registration: ServiceWorkerRegistration, serviceWorker: ServiceWorkerContainer): void {
  if (registration.waiting && serviceWorker.controller) dispatchUpdateReady(registration, registration.waiting);

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed" && serviceWorker.controller) dispatchUpdateReady(registration, installing);
    });
  });
}

function registrationUsesSrtlWorker(registration: ServiceWorkerRegistration): boolean {
  return [registration.installing, registration.waiting, registration.active].some(
    (worker) => worker != null && new URL(worker.scriptURL).pathname === serviceWorkerPath
  );
}

async function disableDevelopmentServiceWorker(serviceWorker: ServiceWorkerContainer): Promise<void> {
  const registration = await serviceWorker.getRegistration("/");
  if (registration && registrationUsesSrtlWorker(registration)) await registration.unregister();

  if (typeof caches === "undefined") return;
  const cacheNames = await caches.keys();
  await Promise.all(cacheNames.filter((name) => name.startsWith(cachePrefix)).map((name) => caches.delete(name)));
}

export function activatePwaUpdate(registration: ActivatablePwaRegistration): void {
  if (!registration.waiting) return;
  registration.waiting.postMessage({ type: activateUpdateMessage });
  if (pendingUpdateRegistration === registration) pendingUpdateRegistration = null;
}

export function getPendingPwaUpdate(): ServiceWorkerRegistration | null {
  if (pendingUpdateRegistration && !pendingUpdateRegistration.waiting) pendingUpdateRegistration = null;
  return pendingUpdateRegistration;
}

export function clearPendingPwaUpdate(registration?: ServiceWorkerRegistration): void {
  if (!registration || pendingUpdateRegistration === registration) pendingUpdateRegistration = null;
}

export async function registerPwaServiceWorker(options: { enabled?: boolean } = {}): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || typeof window === "undefined") return null;

  const enabled = options.enabled ?? productionBuild;
  try {
    if (!enabled) {
      await disableDevelopmentServiceWorker(navigator.serviceWorker);
      return null;
    }
    if (!window.isSecureContext) return null;

    const registration = await navigator.serviceWorker.register(serviceWorkerPath, {
      scope: "/",
      updateViaCache: "none"
    });
    watchForUpdates(registration, navigator.serviceWorker);
    return registration;
  } catch (error) {
    dispatchRegistrationError(error);
    return null;
  }
}
