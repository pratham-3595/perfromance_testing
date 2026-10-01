export const SELECTORS = {
  // Top nav
  tablesTab: 'a[href="http://localhost/tables"], a[href="http://localhost/tables/"], a[href="/tables"], a[href="/tables/"], a[href$="/tables"], a[href$="/tables/"]',
  cartLink: 'a[href="http://localhost/cart"], a[href="/cart"], a[href$="/cart"]',
  checkoutLink: 'a[href="http://localhost/checkout"], a[href="/checkout"], a[href$="/checkout"]',

  // Product tiles on /tables (based on the <a href="http://localhost/products/..."> you pasted)
  // Product tiles on /tables
  productCardLink: 'a[href*="/products/"] img.modern-grid-image',

  // Product page add-to-cart button (based on: <button type="submit" class="button green-box ic-design">Add to Cart</button>)
  addToCartBtn:
    'button[type="submit"].button.green-box.ic-design, button.green-box.ic-design, button[name="add-to-cart"], button.single_add_to_cart_button, .single_add_to_cart_button, a.add_to_cart_button, button.ic-add-to-cart, .ic-add-to-cart',

  // Cart -> proceed to checkout (based on: <input class="to_cart_submit button green-box ic-design" type="submit" value="Place an order">)
  proceedToCheckoutBtn:
    'input.to_cart_submit.button.green-box.ic-design[type="submit"], input.to_cart_submit[type="submit"], a.checkout-button, .checkout-button, a[href="http://localhost/checkout"], a[href^="http://localhost/checkout"], a[href="/checkout"], a[href^="/checkout"]',

  // Checkout form (IC cart/formbuilder)
  checkoutForm: 'form[action="http://localhost/checkout"], form[action$="/checkout"]',

  // Checkout fields (IC form uses `name="cart_*"`)
  company: 'input[name="cart_company"]',
  fullName: 'input[name="cart_name"]',
  address: 'input[name="cart_address"]',
  postal: 'input[name="cart_postal"]',
  city: 'input[name="cart_city"]',
  country: 'select[name="cart_country"]',
  phone: 'input[name="cart_phone"]',
  email: 'input[name="cart_email"]',
  comment: 'textarea[name="cart_comment"]',

  // Place order button (based on: <input value="Place Order" name="cart_submit" class="button green-box ic-design" type="submit">)
  placeOrderBtn:
    'input[name="cart_submit"][type="submit"], button[type="submit"], button.button.green-box.ic-design',

  // Thank-you / order received.
  // This site's "Thank You" page is a plain WordPress page (not a real
  // WooCommerce order-received template), so the real WooCommerce classes
  // (.woocommerce-order-received etc.) never appear here. The actual,
  // reliable confirmation marker is the page heading. Its text is verified
  // separately in the flow — do NOT fall back to a generic container like
  // "#primary" or "body", since that always matches and lets a broken/blank
  // page silently "pass" instead of failing loudly.
  orderReceived: 'h1.entry-title'
};