// Fire-and-forget load generator. Deliberately does NOT await each request
// before starting the next one: once /products starts timing out (2s) under
// a chaos experiment, a sequential loop would collapse from ~10rps to
// ~0.5rps right when the dashboard needs to stay busy. A fixed interval
// keeps request rate constant regardless of downstream latency.

const BASE_URL = process.env.CHECKOUT_API_URL ?? "http://checkout-api:3000";
const INTERVAL_MS = 100; // ~10rps combined
const REQUEST_TIMEOUT_MS = 5000;
const MAX_IN_FLIGHT = 50;

let inFlight = 0;

function fireProducts() {
  inFlight++;
  fetch(`${BASE_URL}/products`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
    .catch(() => {})
    .finally(() => {
      inFlight--;
    });
}

function fireOrder() {
  inFlight++;
  fetch(`${BASE_URL}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: 1, quantity: 1 }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
    .catch(() => {})
    .finally(() => {
      inFlight--;
    });
}

setInterval(() => {
  if (inFlight >= MAX_IN_FLIGHT) return;
  // ~70% reads, ~30% writes
  if (Math.random() < 0.7) {
    fireProducts();
  } else {
    fireOrder();
  }
}, INTERVAL_MS);

console.log(`loadgen started against ${BASE_URL}`);
