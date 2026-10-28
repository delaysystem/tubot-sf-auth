import { describe, expect, it } from "bun:test";
import { vfBootstrapDeployment } from "./browser-echo";

const initFor = (esw: string) =>
  `<script>function initEmbeddedMessaging(){try{embeddedservice_bootstrap.init(\n` +
  `\t\t'00Dxx0000000000',\n\t\t'${esw}',\n\t\t'https://example.my.site.com/ESWTest',\n` +
  `\t\t{\n\t\t\tscrt2URL: 'https://example.my.salesforce-scrt.com'\n\t\t}\n\t);}};</script>`;

describe("vfBootstrapDeployment", () => {
  it("parses the deployment from a multiline bootstrap init", () => {
    expect(vfBootstrapDeployment(initFor("Nu_Message_Channel_TuBot"))).toBe(
      "Nu_Message_Channel_TuBot",
    );
  });
  it("strips a namespace prefix from the esw name", () => {
    expect(vfBootstrapDeployment(initFor("tubot__Nu_Message_Web"))).toBe("Nu_Message_Web");
  });
  it("returns null when no init call is present", () => {
    expect(vfBootstrapDeployment("<apex:page><body>no bootstrap</body></apex:page>")).toBeNull();
  });
});
