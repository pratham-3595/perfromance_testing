module.exports = {
  extends: "lighthouse:default",
  settings: {
    formFactor: "desktop",
    throttlingMethod: "devtools",
    screenEmulation: {
      mobile: false,
      width: 1366,
      height: 768,
      deviceScaleFactor: 1,
      disabled: false
    },
    // IMPORTANT: Lighthouse clears cookies/storage for the origin before
    // auditing by default. That invalidates session-dependent pages such as
    // the WooCommerce /thank-you (order-received) page on repeat runs,
    // causing NO_FCP / all-zero scores. Keeping storage intact preserves the
    // checkout session so the page renders on every run.
    disableStorageReset: true
  }
};
