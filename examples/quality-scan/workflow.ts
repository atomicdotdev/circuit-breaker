import { workflow } from "@circuit-breaker/core";

export default workflow("quality-scan")
  .namespace("ci")
  .description("Vulnerability and secret scan inside a sealed quality VM")
  .machine("cb-quality-v2")

  .place("start", { initialTokens: 1 })
  .place("done")

  .transition("trivy")
  .from("start")
  .to("done")
  .circuit("trivy fs --scanners vuln,secret --severity HIGH,CRITICAL /src")
  .done()

  .build();
