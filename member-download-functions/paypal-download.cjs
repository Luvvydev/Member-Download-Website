/* eslint-disable @typescript-eslint/no-require-imports */
const { getApps, initializeApp } = require("firebase-admin/app");
const { FieldValue, Timestamp, getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { defineSecret, defineString } = require("firebase-functions/params");
const { HttpsError, onCall, onRequest } = require("firebase-functions/v2/https");
const {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} = require("node:crypto");

if (!getApps().length) initializeApp();

const PAYPAL_CLIENT_ID = defineSecret("DOWNLOAD_PAYPAL_CLIENT_ID");
const PAYPAL_CLIENT_SECRET = defineSecret("DOWNLOAD_PAYPAL_CLIENT_SECRET");
const PAYPAL_ENVIRONMENT = defineString("DOWNLOAD_PAYPAL_ENVIRONMENT", { default: "live" });
const PAYPAL_WEBHOOK_ID = defineString("DOWNLOAD_PAYPAL_WEBHOOK_ID", { default: "" });
const DOWNLOAD_SITE_URL = defineString("DOWNLOAD_SITE_URL", { default: "" });
const DOWNLOAD_BUCKET = defineString("DOWNLOAD_BUCKET", {
  default: "chess-ee6b0.firebasestorage.app",
});
const DOWNLOAD_OBJECT_PATH = defineString("DOWNLOAD_OBJECT_PATH", {
  default: "member-downloads/current-download.js",
});
const DOWNLOAD_FILENAME = defineString("DOWNLOAD_FILENAME", {
  default: "Luvvy_LastHit_Obfuscated.js",
});
const DOWNLOAD_PRODUCT_NAME = defineString("DOWNLOAD_PRODUCT_NAME", {
  default: "Member Download",
});

const REGION = "us-central1";
const PRICE = "10.00";
const CURRENCY = "USD";
const CHECKOUT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REVOCATION_EVENTS = new Set([
  "CUSTOMER.DISPUTE.CREATED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
]);

function paypalBaseUrl() {
  return PAYPAL_ENVIRONMENT.value() === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

function siteUrl() {
  const value = DOWNLOAD_SITE_URL.value().trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._~!$&'()*+,;=:@%-]+)*$/i.test(value)) {
    throw new Error("DOWNLOAD_SITE_URL must be a valid HTTPS URL");
  }
  return value;
}

function createBrowserKey() {
  return randomBytes(32).toString("base64url");
}

function hashBrowserKey(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireBrowserKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) {
    throw new HttpsError("invalid-argument", "A valid browser access key is required.");
  }
  return key;
}

function hashesMatch(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function requireOrderId(value) {
  const orderId = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Z0-9]{8,32}$/i.test(orderId)) {
    throw new HttpsError("invalid-argument", "A valid PayPal order ID is required.");
  }
  return orderId;
}

async function paypalAccessToken() {
  const credentials = Buffer.from(
    `${PAYPAL_CLIENT_ID.value()}:${PAYPAL_CLIENT_SECRET.value()}`,
  ).toString("base64");
  const response = await fetch(`${paypalBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(`PayPal authentication failed with ${response.status}`);
  }
  return data.access_token;
}

async function paypalRequest(path, options = {}) {
  const token = await paypalAccessToken();
  const {
    headers: extraHeaders = {},
    requestId = randomUUID(),
    ...fetchOptions
  } = options;
  const response = await fetch(`${paypalBaseUrl()}${path}`, {
    ...fetchOptions,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": requestId,
      Prefer: "return=representation",
      ...extraHeaders,
    },
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(`PayPal request failed with ${response.status}`);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

function getCapture(order) {
  return order?.purchase_units?.[0]?.payments?.captures?.[0] || null;
}

function verifyCompletedOrder(order, expectedCustomId) {
  const unit = order?.purchase_units?.[0];
  const capture = getCapture(order);
  const amount = capture?.amount || unit?.amount;

  if (order?.status !== "COMPLETED" || capture?.status !== "COMPLETED") {
    throw new Error("paypal_order_not_completed");
  }
  if (unit?.custom_id !== expectedCustomId) {
    throw new Error("paypal_order_session_mismatch");
  }
  if (amount?.currency_code !== CURRENCY || amount?.value !== PRICE) {
    throw new Error("paypal_order_amount_mismatch");
  }

  return capture;
}

async function readActiveEntitlement(accessToken) {
  const token = requireBrowserKey(accessToken);
  const tokenHash = hashBrowserKey(token);
  const snapshot = await getFirestore()
    .collection("downloadEntitlements")
    .doc(tokenHash)
    .get();
  return { active: snapshot.data()?.active === true, tokenHash };
}

const paypalCallableOptions = {
  region: REGION,
  secrets: [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET],
  enforceAppCheck: true,
  maxInstances: 10,
};

const protectedCallableOptions = {
  region: REGION,
  enforceAppCheck: true,
  maxInstances: 10,
};

const downloadCreatePaypalOrder = onCall(paypalCallableOptions, async () => {
  const db = getFirestore();
  const checkoutKey = createBrowserKey();
  const checkoutKeyHash = hashBrowserKey(checkoutKey);
  const customId = `download-${checkoutKeyHash.slice(0, 32)}`;
  const returnSiteUrl = siteUrl();
  let order;

  try {
    order = await paypalRequest("/v2/checkout/orders", {
      method: "POST",
      body: JSON.stringify({
        intent: "CAPTURE",
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: DOWNLOAD_PRODUCT_NAME.value(),
              landing_page: "LOGIN",
              payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
              shipping_preference: "NO_SHIPPING",
              user_action: "PAY_NOW",
              return_url: `${returnSiteUrl}/?payment=success`,
              cancel_url: `${returnSiteUrl}/?payment=cancel`,
            },
          },
        },
        purchase_units: [
          {
            custom_id: customId,
            description: `${DOWNLOAD_PRODUCT_NAME.value()} browser access`,
            amount: {
              currency_code: CURRENCY,
              value: PRICE,
            },
          },
        ],
      }),
    });
  } catch (error) {
    console.error("PayPal order creation failed", error);
    throw new HttpsError("internal", "PayPal checkout could not be created.");
  }

  const approvalUrl = order.links?.find(
    (link) => link.rel === "payer-action" || link.rel === "approve",
  )?.href;
  if (!order.id || !approvalUrl) {
    throw new HttpsError("internal", "PayPal did not return an approval link.");
  }

  await db.collection("downloadCheckoutSessions").doc(order.id).set({
    checkoutKeyHash,
    customId,
    status: order.status || "CREATED",
    amount: PRICE,
    currency: CURRENCY,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + CHECKOUT_LIFETIME_MS),
  });

  return { approvalUrl, checkoutKey, orderId: order.id };
});

const downloadCapturePaypalOrder = onCall(paypalCallableOptions, async (request) => {
  const orderId = requireOrderId(request.data?.orderId);
  const checkoutKey = requireBrowserKey(request.data?.checkoutKey);
  const checkoutKeyHash = hashBrowserKey(checkoutKey);
  const db = getFirestore();
  const sessionRef = db.collection("downloadCheckoutSessions").doc(orderId);
  const sessionSnapshot = await sessionRef.get();
  const session = sessionSnapshot.data();

  if (!sessionSnapshot.exists || !hashesMatch(session?.checkoutKeyHash || "", checkoutKeyHash)) {
    throw new HttpsError("permission-denied", "This checkout does not belong to this browser.");
  }

  if (session.status === "COMPLETED") {
    const entitlementSnapshot = await db
      .collection("downloadEntitlements")
      .doc(checkoutKeyHash)
      .get();
    return {
      accessToken: checkoutKey,
      active: entitlementSnapshot.data()?.active === true,
    };
  }

  if (session.expiresAt?.toMillis?.() < Date.now()) {
    throw new HttpsError("deadline-exceeded", "This checkout session has expired.");
  }

  let order;
  try {
    order = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: "POST",
      body: "{}",
      requestId: `download-capture-${orderId}`,
    });
  } catch (captureError) {
    try {
      order = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
        method: "GET",
      });
    } catch (lookupError) {
      console.error("PayPal order capture failed", captureError, lookupError);
      throw new HttpsError("internal", "PayPal payment could not be confirmed.");
    }
  }

  let capture;
  try {
    capture = verifyCompletedOrder(order, session.customId);
  } catch (error) {
    console.error("PayPal order verification failed", error);
    throw new HttpsError("failed-precondition", "PayPal payment is incomplete or does not match this checkout.");
  }

  const entitlementRef = db.collection("downloadEntitlements").doc(checkoutKeyHash);
  const captureIndexRef = db.collection("downloadCaptureIndex").doc(capture.id);

  await db.runTransaction(async (transaction) => {
    const currentSession = await transaction.get(sessionRef);
    const currentData = currentSession.data();
    if (!currentSession.exists || !hashesMatch(currentData?.checkoutKeyHash || "", checkoutKeyHash)) {
      throw new Error("checkout_session_changed");
    }

    transaction.set(entitlementRef, {
      active: true,
      orderId,
      captureId: capture.id,
      purchaseAmount: PRICE,
      purchaseCurrency: CURRENCY,
      payerEmail: order?.payer?.email_address || "",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(captureIndexRef, {
      entitlementId: checkoutKeyHash,
      orderId,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.set(sessionRef, {
      status: "COMPLETED",
      captureId: capture.id,
      payerId: order?.payer?.payer_id || "",
      payerEmail: order?.payer?.email_address || "",
      completedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  return { accessToken: checkoutKey, active: true };
});

const downloadCheckAccess = onCall(protectedCallableOptions, async (request) => {
  const entitlement = await readActiveEntitlement(request.data?.accessToken);
  return { active: entitlement.active };
});

const downloadGetFile = onCall(protectedCallableOptions, async (request) => {
  const entitlement = await readActiveEntitlement(request.data?.accessToken);
  if (!entitlement.active) {
    throw new HttpsError("permission-denied", "Member access is required.");
  }

  const objectPath = DOWNLOAD_OBJECT_PATH.value().trim().replace(/^\/+/, "");
  if (!objectPath) {
    throw new HttpsError("failed-precondition", "The member download has not been uploaded yet.");
  }

  const bucketName = DOWNLOAD_BUCKET.value().trim();
  const bucket = bucketName ? getStorage().bucket(bucketName) : getStorage().bucket();
  const file = bucket.file(objectPath);
  const [exists] = await file.exists();
  if (!exists) {
    throw new HttpsError("not-found", "The member download is unavailable.");
  }

  const safeFilename = DOWNLOAD_FILENAME.value().replace(/[^a-z0-9._ -]/gi, "_");
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 5 * 60 * 1000,
    responseDisposition: `attachment; filename="${safeFilename}"`,
  });

  return { url };
});

function captureIdsFromEvent(event) {
  const resource = event?.resource || {};
  const candidates = [
    resource?.supplementary_data?.related_ids?.capture_id,
    event?.event_type === "PAYMENT.CAPTURE.REVERSED" ? resource.id : "",
    ...(Array.isArray(resource.disputed_transactions)
      ? resource.disputed_transactions.map((transaction) => transaction?.seller_transaction_id)
      : []),
  ];
  return [...new Set(candidates.filter((value) => typeof value === "string" && value))].slice(0, 10);
}

async function verifyWebhook(request) {
  const webhookId = PAYPAL_WEBHOOK_ID.value().trim();
  if (!webhookId) throw new Error("DOWNLOAD_PAYPAL_WEBHOOK_ID is not configured");

  const headers = request.headers;
  const verification = await paypalRequest("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: JSON.stringify({
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: webhookId,
      webhook_event: request.body,
    }),
  });
  return verification?.verification_status === "SUCCESS";
}

const downloadPaypalWebhook = onRequest({
  region: REGION,
  secrets: [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET],
  maxInstances: 5,
}, async (request, response) => {
  if (request.method !== "POST") {
    response.status(405).send("method not allowed");
    return;
  }

  try {
    if (!(await verifyWebhook(request))) {
      response.status(400).send("invalid signature");
      return;
    }
  } catch (error) {
    console.error("PayPal webhook verification failed", error);
    response.status(503).send("webhook verification unavailable");
    return;
  }

  const event = request.body || {};
  if (!REVOCATION_EVENTS.has(event.event_type)) {
    response.status(200).send("ignored");
    return;
  }

  const captureIds = captureIdsFromEvent(event);
  const eventId = /^[A-Za-z0-9._-]{1,200}$/.test(event.id || "")
    ? event.id
    : hashBrowserKey(JSON.stringify(event));
  const db = getFirestore();
  const eventRef = db.collection("downloadPayPalEvents").doc(eventId);
  const indexRefs = captureIds.map((captureId) =>
    db.collection("downloadCaptureIndex").doc(captureId),
  );

  await db.runTransaction(async (transaction) => {
    const eventSnapshot = await transaction.get(eventRef);
    if (eventSnapshot.exists) return;

    const indexSnapshots = await Promise.all(
      indexRefs.map((indexRef) => transaction.get(indexRef)),
    );
    for (const indexSnapshot of indexSnapshots) {
      const index = indexSnapshot.data();
      if (!index?.entitlementId) continue;

      transaction.set(
        db.collection("downloadEntitlements").doc(index.entitlementId),
        {
          active: false,
          revokedAt: FieldValue.serverTimestamp(),
          revokedReason: event.event_type,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      if (index.orderId) {
        transaction.set(
          db.collection("downloadCheckoutSessions").doc(index.orderId),
          {
            paymentStatus: event.event_type,
            paymentStatusUpdatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
    }

    transaction.set(eventRef, {
      eventType: event.event_type,
      captureIds,
      processedAt: FieldValue.serverTimestamp(),
    });
  });

  response.status(200).send("ok");
});

module.exports = {
  downloadCapturePaypalOrder,
  downloadCheckAccess,
  downloadCreatePaypalOrder,
  downloadGetFile,
  downloadPaypalWebhook,
};
