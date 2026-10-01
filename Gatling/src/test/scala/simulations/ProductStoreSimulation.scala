package simulations

import io.gatling.core.Predef._
import io.gatling.core.controller.inject.closed.ClosedInjectionStep
import helpers.BaseHelpers._

import java.util.UUID
import scala.concurrent.duration._

class ProductStoreSimulation extends Simulation {

  // ---------------------------------------------------------------------------
  // Run commands (closed workload model, Gatling 3.5+)
  //
  // Staircase (capacity test, ~85 min):
  //   mvn clean gatling:test "-Dgatling.simulationClass=simulations.ProductStoreSimulation" "-DbaseUrl=http://localhost"
  //
  // Smoke test (~15 min, 10 users):
  //   mvn clean gatling:test "-Dgatling.simulationClass=simulations.ProductStoreSimulation" "-Dprofile=smoke" "-DbaseUrl=http://localhost"
  //
  // Finer steps around the knee (example: 75 -> 175 in steps of 25, 5 min holds):
  //   ... "-DstartUsers=75" "-DstepUsers=25" "-DmaxUsers=175" "-DholdMin=5"
  // ---------------------------------------------------------------------------

  // ---------------- Profile selection ----------------
  private val profile: String = System.getProperty("profile", "staircase")

  // ---------------- Staircase parameters ----------------
  private val startUsers: Int  = Integer.getInteger("startUsers", 0)    // concurrency before first step (0 = from nothing)
  private val stepUsers: Int   = Integer.getInteger("stepUsers", 50)    // users added/removed per step
  private val maxUsers: Int    = Integer.getInteger("maxUsers", 300)    // peak concurrency
  private val rampUpSec: Int   = Integer.getInteger("rampUpSec", 50)    // ramp-up time per step
  private val holdMin: Int     = Integer.getInteger("holdMin", 10)      // hold time at each up-step
  private val rampDownSec: Int = Integer.getInteger("rampDownSec", 20)  // ramp-down time per step
  private val downHoldMin: Int = Integer.getInteger("downHoldMin", 3)   // hold time at each down-step

  // ---------------- Smoke parameters ----------------
  private val smokeUsers: Int   = Integer.getInteger("smokeUsers", 10)
  private val smokeRampSec: Int = Integer.getInteger("smokeRampSec", 30)
  private val smokeHoldSec: Int = Integer.getInteger("smokeHoldSec", 840)
  private val smokeDownSec: Int = Integer.getInteger("smokeDownSec", 30)

  // ---------------- Think time between iterations ----------------
  // Prevents a retry storm: when the server errors, failed users exit the block instantly
  // and would otherwise be replaced immediately, hammering the server (and exhausting
  // ephemeral ports on the load generator).
  private val iterationPauseMin: Int = Integer.getInteger("iterPauseMin", 5)
  private val iterationPauseMax: Int = Integer.getInteger("iterPauseMax", 10)

  private val userFeeder = csv("data/users.csv").circular

  // ---------------- Flows ----------------
  private val openAppFlow =
    group("01 - Open Application") {
      exec(openHome())
    }.exec(pagePause())

  private val tablesFlow =
    group("02 - Tables Tab") {
      exec(openCategory("/tables", "table"))
    }.exec(pagePause())
      .group("03 - Open Random Table Product") {
        exec(pickRandomProductFromCategory("table", "tableProductUrl", "tableProductId"))
          .exec(openChosenProduct("tableProductUrl"))
      }.exec(pagePause())
      .group("04 - Add Table To Cart") {
        exec(addToCartFromSession("tableProductId", "cartContentEncoded"))
          .exec(updateCartState("${tableProductId}"))
      }.exec(pagePause())

  // 50% branch
  private val chairsFlow =
    group("05 - Chairs Tab (50%)") {
      exec(openCategory("/chairs", "chair"))
    }.exec(pagePause())
      .group("06 - Open Random Chair Product (50%)") {
        exec(pickRandomProductFromCategory("chair", "chairProductUrl", "chairProductId"))
          .exec(openChosenProduct("chairProductUrl"))
      }.exec(pagePause())
      .group("07 - Add Chair To Cart (50%)") {
        exec(addToCartFromSession("chairProductId", "cartContentEncoded"))
          .exec(updateCartState("${chairProductId}"))
      }.exec(pagePause())

  // 30% branch
  private val checkoutFlow =
    group("08 - Open Cart + Validate State (30%)") {
      exec(openCartAndValidate())
    }.exec(pagePause())
      .group("09 - Checkout Start (30%)") {
        exec(session => session.set("transId", UUID.randomUUID().toString.replace("-", "").take(14)))
          .exec(checkoutStart("transId"))
      }.exec(pagePause())
      .group("09.1 - Country/State Dropdown (30%)") {
        feed(userFeeder)
          .exec(loadStatesDropdown())
      }.exec(pagePause())
      .group("10 - Place Order Submit (30%)") {
        exec(checkoutSubmit())
      }.exec(pagePause())

  private val scn =
    scenario("Product Store - Capacity Test")
      .exec(flushAll())
      .exec(initCartState())
      .exitBlockOnFail {
        exec(openAppFlow)
          .exec(tablesFlow)
          .randomSwitch(50.0 -> exec(chairsFlow))
          .randomSwitch(30.0 -> exec(checkoutFlow))
      }
      // Always runs (success or failure) so failing users back off
      .pause(iterationPauseMin.seconds, iterationPauseMax.seconds)

  // ---------------- Staircase profile ----------------
  private val levels: Int = (maxUsers - startUsers) / stepUsers

  // Ramp UP: e.g. 0->50 (50s) hold 10m, 50->100 (50s) hold 10m, ... ->300 (50s) hold 10m
  private val upSteps = (1 to levels).flatMap { i =>
    val from = startUsers + (i - 1) * stepUsers
    val to   = startUsers + i * stepUsers
    Seq(
      rampConcurrentUsers(from).to(to).during(rampUpSec.seconds),
      constantConcurrentUsers(to).during(holdMin.minutes)
    )
  }

  // Ramp DOWN: e.g. 300->250 (20s) hold 3m, ... 100->50 (20s) hold 3m, 50->0 (20s)
  private val downSteps = (levels to 1 by -1).flatMap { i =>
    val from = startUsers + i * stepUsers
    val to   = startUsers + (i - 1) * stepUsers
    val ramp = rampConcurrentUsers(from).to(to).during(rampDownSec.seconds)
    if (i > 1) Seq(ramp, constantConcurrentUsers(to).during(downHoldMin.minutes))
    else Seq(ramp) // last step: no hold needed
  }

  // If startUsers > 0 the final ramp-down only returns to startUsers; add a ramp to 0
  private val finalDrain =
    if (startUsers > 0) Seq(rampConcurrentUsers(startUsers).to(0).during(rampDownSec.seconds))
    else Seq.empty

  private val staircase: List[ClosedInjectionStep] = (upSteps ++ downSteps ++ finalDrain).toList

  // ---------------- Smoke profile ----------------
  private val smoke: List[ClosedInjectionStep] = List(
    rampConcurrentUsers(0).to(smokeUsers).during(smokeRampSec.seconds),
    constantConcurrentUsers(smokeUsers).during(smokeHoldSec.seconds),
    rampConcurrentUsers(smokeUsers).to(0).during(smokeDownSec.seconds)
  )

  private val selectedProfile: List[ClosedInjectionStep] = if (profile == "smoke") smoke else staircase

  setUp(
    scn.inject(selectedProfile.head, selectedProfile.tail: _*)
  ).protocols(httpProtocol)
    .assertions(
      global.failedRequests.percent.lt(1),
      global.responseTime.percentile(95).lt(3000)
    )
}