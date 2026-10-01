import { SELECTORS as S } from "../config/selectors.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickFirst(page, selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 60000 });
  const el = await page.$(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  await el.click();
}

async function typeIfExists(page, selector, value) {
  const el = await page.$(selector);
  if (!el) return false;

  await page.focus(selector);

  await page.evaluate((sel) => {
    const i = document.querySelector(sel);
    if (i) i.value = "";
  }, selector);

  await page.type(selector, value, { delay: 5 });
  return true;
}

async function waitForPathIncludes(page, part, timeout = 60000) {
  await page.waitForFunction(
    (p) => window.location.pathname.includes(p),
    { timeout },
    part
  );
}

/**
 * Runs the full add-to-cart -> checkout -> thank-you flow, driving a
 * Lighthouse User Flow (`flow`) so every page is audited live, in the same
 * tab/session, at the exact moment the real browser navigation produced it.
 *
 * IMPORTANT: cart/checkout/thank-you here are rendered from a real HTML
 * <form> submission (POST), not a plain GET. Auditing them afterwards via an
 * independent `lighthouse(url)` call (a fresh GET navigation) throws away
 * that POST-derived state, so the server re-renders an empty/default page
 * (e.g. the checkout report ends up showing the empty Cart markup). Wrapping
 * each click with `flow.startNavigation()`/`flow.endNavigation()` (or
 * `flow.navigate()` for the very first, plain GET load) captures the page
 * exactly as the flow produced it - no reload, no lost state.
 *
 * @returns {Promise<{home:string, tables:string, product:string, cart:string, checkout:string, thankYou:string}>}
 */
export async function placeOrderFlow(page, appUrl, flow) {
  const visited = {};

  // 1) Open app (Home) - plain GET, safe to drive directly.
  await flow.navigate(() => page.goto(appUrl, { waitUntil: "domcontentloaded" }), {
    name: "Home"
  });
  visited.home = page.url();

  // 2) Go to Tables (user-triggered navigation - audit the live result)
  await page.waitForSelector(S.tablesTab, { visible: true, timeout: 60000 });
  await flow.startNavigation({ name: "Tables" });
  await page.click(S.tablesTab);
  await flow.endNavigation();

  // Don't rely on waitForNavigation; wait for tables page + products to appear
  await waitForPathIncludes(page, "tables");
  await page.waitForSelector(S.productCardLink, { visible: true, timeout: 60000 });
  await sleep(300);
  visited.tables = page.url();

  // 3) Open a product (user-triggered navigation)
  await page.waitForSelector(S.productCardLink, { visible: true, timeout: 60000 });
  await flow.startNavigation({ name: "Product" });
  await clickFirst(page, S.productCardLink);
  await flow.endNavigation();

  // 4) Add to cart
  await page.waitForSelector(S.addToCartBtn, { visible: true, timeout: 60000 });
  visited.product = page.url();
  await page.click(S.addToCartBtn);
  await sleep(800);

  // 5) Open cart (user-triggered navigation)
  await page.waitForSelector(S.cartLink, { visible: true, timeout: 60000 });
  await flow.startNavigation({ name: "Cart" });
  await page.click(S.cartLink);
  await flow.endNavigation();

  await waitForPathIncludes(page, "cart");
  visited.cart = page.url();

  // 6) Proceed to checkout (form POST - a user-triggered navigation).
  // Auditing this live, right after the POST, is what actually fixes the
  // "checkout report shows the cart page" bug: a later independent GET to
  // the checkout URL has no POST body, so the server falls back to cart.
  await page.waitForSelector(S.proceedToCheckoutBtn, { visible: true, timeout: 60000 });
  await flow.startNavigation({ name: "Checkout" });
  await page.click(S.proceedToCheckoutBtn);
  await flow.endNavigation();

  // Wait for checkout page (URL + form)
  await waitForPathIncludes(page, "checkout");
  await page.waitForSelector(S.checkoutForm, { timeout: 60000 });
  visited.checkout = page.url();

  // 7) Fill checkout fields
  await typeIfExists(page, S.company, "Test Company");
  await typeIfExists(page, S.fullName, "Test User");
  await typeIfExists(page, S.address, "221B Baker Street");
  await typeIfExists(page, S.postal, "NW16XE");
  await typeIfExists(page, S.city, "London");
  await typeIfExists(page, S.phone, "9999999999");
  await typeIfExists(page, S.email, "test.user@example.com");
  await typeIfExists(page, S.comment, "Automation order");

  // Country select (only if present)
  const countryEl = await page.$(S.country);
  if (countryEl) {
    await page.select(S.country, "AF");
  }

  // 8) Place order (form POST - user-triggered navigation to thank-you)
  await page.waitForSelector(S.placeOrderBtn, { visible: true, timeout: 60000 });
  await flow.startNavigation({ name: "ThankYou" });
  await page.click(S.placeOrderBtn);
  await flow.endNavigation();

  // 9) Confirm thank-you page. Fail loudly with a clear message on a real
  // miss instead of silently matching a generic fallback like "body".
  await waitForPathIncludes(page, "thank-you");
  let headingText = "";
  try {
    await page.waitForSelector(S.orderReceived, { timeout: 60000 });
    headingText = await page.$eval(S.orderReceived, (el) => el.textContent.trim());
  } catch (e) {
    throw new Error(
      `Order confirmation not found on thank-you page (selector: "${S.orderReceived}"). ` +
      `Current URL: ${page.url()}. The order likely failed, or the checkout ` +
      `session/cookie was cleared before this check. Original error: ${e.message}`
    );
  }

  if (!/thank/i.test(headingText)) {
    throw new Error(
      `Thank-you page heading did not contain the expected confirmation text. ` +
      `Current URL: ${page.url()}. Heading found: "${headingText}"`
    );
  }
  visited.thankYou = page.url();

  return visited;
}