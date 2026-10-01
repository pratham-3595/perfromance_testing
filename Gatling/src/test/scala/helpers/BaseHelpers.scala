package helpers

import io.gatling.core.Predef._
import io.gatling.http.Predef._
import io.gatling.core.structure.ChainBuilder

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import scala.concurrent.duration._
import scala.util.Random

object BaseHelpers {

  // ---------------- Execution params ----------------
  val baseUrl: String = System.getProperty("baseUrl", "http://localhost")
  val users: Int = Integer.getInteger("users", 100)
  val rampSeconds: Int = Integer.getInteger("rampSeconds", 10)

  // (Optional advanced closed model params, not used unless you enable in Simulation)
  val cu: Double = java.lang.Double.parseDouble(System.getProperty("cu", "10"))
  val durSec: Int = Integer.getInteger("durSec", 30)

  // ---------------- HTTP Protocol ----------------
  val httpProtocol = http
    .baseUrl(baseUrl)
    // 100% backend/business requests: don't auto-fetch resources
    .acceptHeader("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
    .userAgentHeader("Gatling")

  val ajaxHeaders: Map[String, String] = Map(
    "Origin" -> baseUrl,
    "X-Requested-With" -> "XMLHttpRequest",
    "Content-Type" -> "application/x-www-form-urlencoded; charset=UTF-8",
    "Accept" -> "*/*"
  )

  // Preflight note:
  // Browsers can send OPTIONS preflight for CORS.
  // Gatling is not a browser and calls endpoints directly, so preflight is typically not required.

  // ---------------- Required helper blocks ----------------
  def flushAll(): ChainBuilder =
    exec(flushHttpCache)
      .exec(flushSessionCookies)
      .exec(flushCookieJar)

  def pagePause(): ChainBuilder = pause(1, 3)

  // ---------------- Cart state helpers ----------------
  private def urlEncode(s: String): String =
    URLEncoder.encode(s, StandardCharsets.UTF_8.toString)

  def initCartState(): ChainBuilder =
    exec(_.set("cartIds", Seq.empty[String]))
      .exec(_.set("cartJson", "{}"))
      .exec(_.set("cartContentEncoded", ""))

  /**
   * Updates session cart:
   * cartIds: Seq("116", "86")
   * cartJson: {"116__":1,"86__":1}
   * cartContentEncoded: urlencoded(cartJson)
   */
  def updateCartState(productIdExpr: String): ChainBuilder =
    exec { session =>
      val productId = session(productIdExpr.drop(2).dropRight(1)).as[String] // expects "${key}"
      val current = session("cartIds").asOption[Seq[String]].getOrElse(Seq.empty)

      val updated = if (current.contains(productId)) current else current :+ productId
      val cartJson = updated.map(id => s""""${id}__":1""").mkString("{", ",", "}")
      val cartContentEncoded = if (updated.isEmpty) "" else urlEncode(cartJson)

      session
        .set("cartIds", updated)
        .set("cartJson", cartJson)
        .set("cartContentEncoded", cartContentEncoded)
    }

  // ---------------- Core business requests ----------------
  def openHome(): ChainBuilder =
    exec(http("GET /").get("/").check(status.in(200, 304)))

  /**
   * Extract from category page:
   * - ids: product-116, product-114, etc.
   * - urls: /products/slug (strip baseUrl if present)
   *
   * Stored as:
   *   tableIds / tableUrls   when prefix="table"
   *   chairIds / chairUrls   when prefix="chair"
   */
  def openCategory(categoryPath: String, prefix: String): ChainBuilder =
    exec(
      http(s"GET $categoryPath")
        .get(categoryPath)
        .check(status.in(200, 304))
        .check(regex("""\bproduct-(\d+)\b""").findAll.saveAs(s"${prefix}Ids"))
        .check(regex("""href="(?:https?:\/\/[^"]+)?(\/products\/[^"]+)"""").findAll.saveAs(s"${prefix}Urls"))
    ).exec { session =>
      val ids = session(s"${prefix}Ids").asOption[Seq[String]].getOrElse(Seq.empty)
      val urls = session(s"${prefix}Urls").asOption[Seq[String]].getOrElse(Seq.empty)

      if (ids.nonEmpty && urls.nonEmpty) session else session.markAsFailed
    }

  /**
   * Pick random index and set:
   *   idKey  -> chosen id
   *   urlKey -> chosen url path (/products/...)
   *
   * IMPORTANT: No extra closing brace after this method.
   */
  def pickRandomProductFromCategory(prefix: String, urlKey: String, idKey: String): ChainBuilder =
    exec { session =>
      val ids = session(s"${prefix}Ids").asOption[Seq[String]].getOrElse(Seq.empty)
      val urls = session(s"${prefix}Urls").asOption[Seq[String]].getOrElse(Seq.empty)

      val n = Math.min(ids.size, urls.size)
      if (n <= 0) session.markAsFailed
      else {
        val i = Random.nextInt(n)
        session.set(idKey, ids(i)).set(urlKey, urls(i))
      }
    }

  def openChosenProduct(productUrlSessionKey: String): ChainBuilder =
    exec(
      http(s"GET $${$productUrlSessionKey}")
        .get(s"$${$productUrlSessionKey}")
        .check(status.in(200, 304))
    )

  def addToCartFromSession(productIdKey: String, cartContentKey: String): ChainBuilder =
    exec(
      http(s"POST admin-ajax ic_add_to_cart ($${$productIdKey})")
        .post("/wp-admin/admin-ajax.php")
        .headers(ajaxHeaders)
        .formParam("action", "ic_add_to_cart")
        .formParam(
          "add_cart_data",
          s"current_product=$${$productIdKey}&cart_content=$${$cartContentKey}&current_quantity=1"
        )
        .formParam("cart_widget", "0")
        .formParam("cart_container", "0")
        .check(status.is(200))
    )

  /**
   * Cart validation:
   * We rely on "product-<id>" markers on cart page (same as listing).
   */
  def openCartAndValidate(): ChainBuilder =
    exec(
      http("GET /cart")
        .get("/cart")
        .check(status.in(200, 304))
        // extract JSON from cart_content=" {...} " (handles html-escaped quotes too)
        .check(regex("""cart_content[^<]*?(\{[^}]+\})""").find.saveAs("cartJsonFromPage"))
    ).exec { session =>
      val expectedCartJson = session("cartJson").asOption[String].getOrElse("{}")
      val actualCartJson = session("cartJsonFromPage").asOption[String].getOrElse("")

      // Basic validation: all expected ids appear in the cart json
      val expectedIds = session("cartIds").asOption[Seq[String]].getOrElse(Seq.empty)

      val allPresent = expectedIds.forall(id => actualCartJson.contains(s""""${id}__""""))
      if (allPresent) session else session.markAsFailed
    }

  // ---------------- Checkout (CSV-driven, no hardcoded .dat) ----------------
  def checkoutStart(transIdKey: String): ChainBuilder =
    exec(
      http("POST /checkout (start)")
        .post("/checkout")
        .formParam("cart_content", "${cartJson}")
        // Keep minimal; plugin typically re-evaluates totals
        .formParam("total_net", "0")
        .formParam("trans_id", s"$${$transIdKey}")
        .formParam("shipping", "order")
        .check(status.in(200, 302))
    )

  def loadStatesDropdown(): ChainBuilder =
    exec(
      http("POST admin-ajax ic_state_dropdown")
        .post("/wp-admin/admin-ajax.php")
        .headers(ajaxHeaders)
        .formParam("action", "ic_state_dropdown")
        .formParam("country_code", "${country}")
        .formParam("state_code", "${state}")
        .check(status.is(200))
    )

  def checkoutSubmit(): ChainBuilder =
    exec(
      http("POST /checkout (submit order)")
        .post("/checkout")
        .formParam("ic_formbuilder_redirect", s"$baseUrl/thank-you")
        .formParam("cart_content", "${cartJson}")
        .formParam("shipping", "order")
        .formParam("cart_type", "order")

        .formParam("cart_company", "${company}")
        .formParam("cart_name", "${full_name}")
        .formParam("cart_address", "${address}")
        .formParam("cart_postal", "${postal_code}")
        .formParam("cart_city", "${city}")
        .formParam("cart_country", "${country}")
        .formParam("cart_state", "${state}")
        .formParam("cart_phone", "${phone}")
        .formParam("cart_email", "${email}")
        .formParam("cart_comment", "${comment}")

        .formParam("cart_s_company", "")
        .formParam("cart_s_name", "${full_name}")
        .formParam("cart_s_address", "${address}")
        .formParam("cart_s_postal", "${postal_code}")
        .formParam("cart_s_city", "${city}")
        .formParam("cart_s_country", "")
        .formParam("cart_s_state", "")
        .formParam("cart_s_phone", "${phone}")
        .formParam("cart_s_email", "${email}")
        .formParam("cart_s_comment", "${comment}")

        .formParam("cart_submit", "Place Order")
        .check(status.in(200, 302))
    )
}