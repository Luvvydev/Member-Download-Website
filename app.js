import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app-check.js";
import {
  getFunctions,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-functions.js";

const config = window.MEMBER_DOWNLOAD_CONFIG;
const ACCESS_TOKEN_KEY = "member-download-access-v1";
const PENDING_CHECKOUT_KEY = "member-download-checkout-v1";
const statusDot = document.querySelector("#status-dot");
const browserStatus = document.querySelector("#browser-status");
const purchaseButton = document.querySelector("#purchase-button");
const configurationNote = document.querySelector("#configuration-note");
const browserIcon = document.querySelector("#browser-icon");
const accessTitle = document.querySelector("#access-title");
const accessDescription = document.querySelector("#access-description");
const toastElement = document.querySelector("#toast");
let toastTimer = 0;
let hasAccess = false;
let busy = false;

for (const element of document.querySelectorAll("[data-product-name]")) {
  element.textContent = config.productName;
}
for (const element of document.querySelectorAll("[data-price-label]")) {
  element.textContent = config.priceLabel;
}
document.title = config.productName;

function showToast(message, type = "info") {
  window.clearTimeout(toastTimer);
  toastElement.textContent = message;
  toastElement.className = `toast ${type}`;
  toastElement.hidden = false;
  toastTimer = window.setTimeout(() => {
    toastElement.hidden = true;
  }, 5200);
}

function readPendingCheckout() {
  try {
    const value = window.localStorage.getItem(PENDING_CHECKOUT_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value);
    if (!parsed.orderId || !parsed.checkoutKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

const appCheckConfigured = Boolean(config.appCheckSiteKey);
const firebaseConfigured = Boolean(
  config.firebase?.apiKey &&
  config.firebase?.authDomain &&
  config.firebase?.projectId &&
  config.firebase?.appId,
);
const siteConfigured = firebaseConfigured && appCheckConfigured;
let functions = null;

if (firebaseConfigured) {
  const app = initializeApp(config.firebase);
  if (appCheckConfigured) {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(config.appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }
  functions = getFunctions(app, "us-central1");
}

function render() {
  statusDot.classList.toggle("active", hasAccess);
  browserIcon.classList.toggle("active", hasAccess);
  browserIcon.textContent = hasAccess ? "✓" : "▣";
  accessTitle.textContent = hasAccess
    ? "Member access is active"
    : "Access is not unlocked yet";
  accessDescription.textContent = hasAccess
    ? "You can return here and download again from this browser."
    : `Complete the ${config.priceLabel} PayPal payment once to remember access here.`;

  if (!siteConfigured) {
    browserStatus.textContent = "Setup required";
    configurationNote.hidden = false;
  } else if (busy) {
    browserStatus.textContent = "Checking this browser";
    configurationNote.hidden = true;
  } else if (hasAccess) {
    browserStatus.textContent = "Member access active";
    configurationNote.hidden = true;
  } else {
    browserStatus.textContent = "Ready for purchase";
    configurationNote.hidden = true;
  }

  purchaseButton.disabled =
    busy || !siteConfigured || !config.downloadReady;
  purchaseButton.textContent = !config.downloadReady
    ? "Download setup required"
    : busy
      ? "Please wait"
      : hasAccess
        ? "Download now"
        : `Unlock for ${config.priceLabel}`;
}

async function checkStoredAccess(accessToken) {
  const checkAccess = httpsCallable(functions, "downloadCheckAccess");
  const result = await checkAccess({ accessToken });
  return result.data.active === true;
}

async function initializeAccess() {
  render();
  if (!siteConfigured || !functions) return;

  busy = true;
  render();
  const params = new URLSearchParams(window.location.search);
  const paymentStatus = params.get("payment");
  const returnedOrderId = params.get("token") || "";

  if (paymentStatus === "cancel") {
    window.localStorage.removeItem(PENDING_CHECKOUT_KEY);
    window.history.replaceState({}, "", window.location.pathname);
    showToast("PayPal checkout was cancelled. You were not charged.");
  }

  if (paymentStatus === "success" && returnedOrderId) {
    const pending = readPendingCheckout();
    if (pending?.orderId === returnedOrderId) {
      try {
        const captureOrder = httpsCallable(functions, "downloadCapturePaypalOrder");
        const result = await captureOrder(pending);
        if (!result.data.active || !result.data.accessToken) {
          throw new Error("access_not_activated");
        }
        window.localStorage.setItem(ACCESS_TOKEN_KEY, result.data.accessToken);
        window.localStorage.removeItem(PENDING_CHECKOUT_KEY);
        window.history.replaceState({}, "", window.location.pathname);
        hasAccess = true;
        busy = false;
        render();
        showToast("Payment confirmed. This browser now has member access.", "success");
        return;
      } catch {
        showToast("PayPal could not be confirmed. Refresh this page to try again.", "error");
      }
    } else {
      showToast("This browser no longer has the checkout key needed to confirm payment.", "error");
    }
  }

  const accessToken = window.localStorage.getItem(ACCESS_TOKEN_KEY);
  if (accessToken) {
    try {
      hasAccess = await checkStoredAccess(accessToken);
      if (!hasAccess) window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    } catch {
      showToast("Member access could not be checked. Refresh the page to retry.", "error");
    }
  }

  busy = false;
  render();
}

async function startCheckout() {
  if (!config.downloadReady) {
    showToast("The download must be uploaded before live payments are enabled.");
    return;
  }
  if (!siteConfigured || !functions) {
    showToast("Firebase App Check has not been configured yet.", "error");
    return;
  }

  busy = true;
  render();
  try {
    const createOrder = httpsCallable(functions, "downloadCreatePaypalOrder");
    const result = await createOrder({});
    const { approvalUrl, checkoutKey, orderId } = result.data;
    if (!approvalUrl || !checkoutKey || !orderId) {
      throw new Error("incomplete_checkout");
    }
    window.localStorage.setItem(
      PENDING_CHECKOUT_KEY,
      JSON.stringify({ checkoutKey, orderId }),
    );
    window.location.assign(approvalUrl);
  } catch {
    busy = false;
    render();
    showToast("PayPal checkout could not start. Try again.", "error");
  }
}

async function startDownload() {
  const accessToken = window.localStorage.getItem(ACCESS_TOKEN_KEY);
  if (!accessToken || !hasAccess || !functions) return;

  busy = true;
  render();
  try {
    const getDownload = httpsCallable(functions, "downloadGetFile");
    const result = await getDownload({ accessToken });
    if (!result.data.url) throw new Error("missing_download_url");
    window.location.assign(result.data.url);
  } catch {
    busy = false;
    render();
    showToast("The secure download link could not be created. Try again.", "error");
  }
}

purchaseButton.addEventListener("click", () => {
  if (hasAccess) void startDownload();
  else void startCheckout();
});

void initializeAccess();
