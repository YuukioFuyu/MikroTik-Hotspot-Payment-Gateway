// =========================
// ENVIRONMENT CONFIGURATION
// =========================
const ENV = {
  USE_SANDBOX: true, // Set false for production

  SERVER_KEY: {
    sandbox: 'YOUR_SANDBOX_SERVER_KEY', // Midtrans Sandbox Server key (If you looking for Client Key, Please check "payment.htm")
    production: 'YOUR_PRODUCTION_SERVER_KEY' // Midtrans Production Server key (If you looking for Client Key, Please check "payment.htm")
  },

  BASE_URL: {
    snap: {
      sandbox: 'https://app.sandbox.midtrans.com/snap/v1/transactions',
      production: 'https://app.midtrans.com/snap/v1/transactions'
    },
    status: {
      sandbox: 'https://api.sandbox.midtrans.com/v2',
      production: 'https://api.midtrans.com/v2'
    }
  },

  PAYMENT_CALLBACK_URL: 'http://your-cloudflare-backend-url/verify',
  LOGIN_REDIRECT_BASE: 'http://your-hotspot-login-url',
  DEFAULT_DST: 'http://your-hotspot-dns',
  DEFAULT_AMOUNT: 3000, // Your Internet Hotspot Price
  COUNTRY_VAT: '11', // Your Country VAT
  ALLOWED_METHODS: [
    "gopay", "shopeepay", "other_qris",
    "echannel", "bri_va", "cimb_va",
    "bni_va", "permata_va", "other_va"
  ],
  SECRET_TOKEN_KEY: 'YOUR_SECRET_KEY_HERE',
  TOKEN_VALIDITY_SECONDS: 60
};

// =========================
// FEE & VAT CALCULATION
// =========================
function calculateFee(amount, paymentMethod) {
  let fee = 0;

  switch (paymentMethod) {
    case 'gopay':
    case 'shopeepay':
    case 'akulaku':
    case 'kredivo':
      fee = amount * 0.02;
      break;
    case 'other_qris':
      fee = amount * 0.007;
      break;
    case 'credit_card':
      fee = amount * 0.029 + 2000;
      break;
    case 'echannel':
    case 'bri_va':
    case 'cimb_va':
    case 'bni_va':
    case 'permata_va':
    case 'other_va':
      fee = 4000;
      break;
    case 'indomaret':
    case 'alfamart':
    case 'alfamidi':
    case 'dan_dan':
      fee = 5000;
      break;
    default:
      fee = 0;
  }

  return Math.round(fee);
}

function calculateVAT(amount, paymentMethod) {
  const vatApplicable = [
    'credit_card', 'akulaku', 'kredivo',
    'echannel', 'bri_va', 'cimb_va',
    'bni_va', 'permata_va', 'other_va'
  ];

  if (!vatApplicable.includes(paymentMethod)) return 0;

  const vatPercent = parseFloat(ENV.COUNTRY_VAT) || 0;
  return Math.round(amount * (vatPercent / 100));
}

// =========================
// TOKEN UTILITY
// =========================
async function generateToken(mac, timestamp) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(ENV.SECRET_TOKEN_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const message = new TextEncoder().encode(`${timestamp}${mac}`);
  const signature = await crypto.subtle.sign("HMAC", key, message);

  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

// =========================
// HANDLE PRE-AUTH
// =========================
async function handlePreAuth(request) {
  const url = new URL(request.url);
  const mac = url.searchParams.get("mac");
  const timestamp = parseInt(url.searchParams.get("timestamp"));

  if (!mac || !timestamp) {
    return new Response("Missing parameters", { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 10) {
    return new Response("Timestamp too far from current time", { status: 403 });
  }

  const token = await generateToken(mac, timestamp);

  return new Response(JSON.stringify({ token }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ENV.DEFAULT_DST
    }
  });
}

// =========================
// HANDLE SNAP TOKEN REQUEST
// =========================
async function handleSnapTokenRequest(request) {
  const url = new URL(request.url);
  const mac = url.searchParams.get("mac");
  const dst = url.searchParams.get("dst") || ENV.DEFAULT_DST;
  const method = url.searchParams.get("method") || "other_qris";
  const timestamp = parseInt(url.searchParams.get("timestamp"));
  const token = url.searchParams.get("token");

  if (!mac || !dst || !method || !timestamp || !token) {
    return new Response("Missing required parameters.", { status: 400 });
  }

  if (!ENV.ALLOWED_METHODS.includes(method)) {
    return new Response("Invalid payment method", { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > ENV.TOKEN_VALIDITY_SECONDS) {
    return new Response(`
      <script>
        console.warn("Token expired");
        location.href = "${ENV.DEFAULT_DST}";
      </script>
    `, {
      status: 200,
      headers: {
        "Content-Type": "text/html",
        "Access-Control-Allow-Origin": ENV.DEFAULT_DST
      }
    });
  }

  const expected = await generateToken(mac, timestamp);
  if (token !== expected) {
    return new Response("Invalid token", { status: 403 });
  }

  const amount = ENV.DEFAULT_AMOUNT;
  const fee = calculateFee(amount, method);
  const vat = calculateVAT(amount, method);
  const gross_amount = amount + fee + vat;
  const order_id = `hotspot-${mac}-${Date.now()}`;

  const item_details = [
    { id: order_id, price: amount, quantity: 1, name: "Internet Hotspot" },
    { id: "fee", price: fee, quantity: 1, name: "Settlement Fee" },
    { id: "vat", price: vat, quantity: 1, name: `VAT ${ENV.COUNTRY_VAT}%` }
  ];

  const body = {
    transaction_details: { order_id, gross_amount },
    item_details,
    customer_details: {
      first_name: `${mac}`,
      email: `${mac}@mail.com`
    },
    callbacks: {
      finish: `${ENV.PAYMENT_CALLBACK_URL}?order_id=${order_id}&mac=${mac}&dst=${encodeURIComponent(dst)}`
    },
    enabled_payments: [method]
  };

  const serverKey = ENV.USE_SANDBOX ? ENV.SERVER_KEY.sandbox : ENV.SERVER_KEY.production;
  const snapUrl = ENV.USE_SANDBOX ? ENV.BASE_URL.snap.sandbox : ENV.BASE_URL.snap.production;
  const auth = btoa(`${serverKey}:`);

  const response = await fetch(snapUrl, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const result = await response.json();

  if (result.token) {
    return new Response(JSON.stringify({ token: result.token }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": ENV.DEFAULT_DST
      }
    });
  }
}

// =========================
// HANDLE CALLBACK VERIFY
// =========================
async function handleSnapCallbackVerify(request) {
  const url = new URL(request.url);
  const order_id = url.searchParams.get("order_id");
  const mac = url.searchParams.get("mac");
  const dst = decodeURIComponent(url.searchParams.get("dst") || ENV.DEFAULT_DST);

  let transaction_status = url.searchParams.get("transaction_status");

  if (!order_id || !mac || !dst) {
    return new Response("Missing callback parameters", { status: 400 });
  }

  if (!transaction_status) {
    const serverKey = ENV.USE_SANDBOX ? ENV.SERVER_KEY.sandbox : ENV.SERVER_KEY.production;
    const statusBase = ENV.USE_SANDBOX ? ENV.BASE_URL.status.sandbox : ENV.BASE_URL.status.production;
    const auth = btoa(`${serverKey}:`);

    const txStatus = await fetch(`${statusBase}/${order_id}/status`, {
      headers: { "Authorization": `Basic ${auth}` }
    });

    const result = await txStatus.json();
    transaction_status = result.transaction_status;
  }

  if (["settlement", "capture"].includes(transaction_status)) {
    const timestamp = Math.floor(Date.now() / 1000);
    const token = await generateToken(mac, timestamp);
    const redirectUrl = `${ENV.LOGIN_REDIRECT_BASE}?username=T-${mac}&dst=${encodeURIComponent(dst)}&timestamp=${timestamp}&token=${encodeURIComponent(token)}`;

    return Response.redirect(redirectUrl, 302);
  }

  return new Response("Payment not yet completed", { status: 403 });
}

// =========================
// HANDLE TOKEN VALIDATION
// =========================
async function handleSessionAuth(request) {
  const url = new URL(request.url);
  const mac = url.searchParams.get("mac");
  const timestamp = parseInt(url.searchParams.get("timestamp"));
  const token = url.searchParams.get("token");

  if (!mac || !timestamp || !token) {
    return new Response("Missing auth parameters", { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > ENV.TOKEN_VALIDITY_SECONDS) {
    return new Response(`
      <script>
        console.warn("Token expired");
        location.href = "${ENV.DEFAULT_DST}";
      </script>
    `, {
      status: 200,
      headers: {
        "Content-Type": "text/html",
        "Access-Control-Allow-Origin": ENV.DEFAULT_DST
      }
    });
  }

  const expected = await generateToken(mac, timestamp);

  return token === expected
    ? new Response("OK", { status: 200 })
    : new Response("Invalid token", { status: 403 });
}

// =========================
// MAIN WORKER HANDLER
// =========================
addEventListener("fetch", event => {
  const { pathname } = new URL(event.request.url);

  if (pathname.startsWith("/pay")) {
    return event.respondWith(handleSnapTokenRequest(event.request));
  }

  if (pathname.startsWith("/verify")) {
    return event.respondWith(handleSnapCallbackVerify(event.request));
  }

  if (pathname.startsWith("/auth")) {
    return event.respondWith(handleSessionAuth(event.request));
  }

  if (pathname.startsWith("/preauth")) {
    return event.respondWith(handlePreAuth(event.request));
  }

  return event.respondWith(new Response("Not found", { status: 404 }));
});