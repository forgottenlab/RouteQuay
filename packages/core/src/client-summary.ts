import type { RedactedConfigDiagnostic } from "./config-shape.ts";

export type ClientSummary = {
  clientIndex: number;
  idPresent: boolean;
  emailPresent: boolean;
  flowPresent: boolean;
  flowTypePresent: boolean;
  inboundIndex: number;
  protocol: string;
  security: string;
  enabledAssumed: true;
  displayName: string;
};

export type ClientInventorySummary = {
  schemaVersion: "client-inventory-summary-v1";
  clientCount: number;
  clients: ClientSummary[];
  contentReadForSummaryOnly: true;
  rawSecretValuesEmitted: false;
  diagnostics: RedactedConfigDiagnostic[];
};

export function summarizeXrayClients(input: unknown): ClientInventorySummary {
  const config = unwrapXrayConfig(input);
  const diagnostics: RedactedConfigDiagnostic[] = [];

  if (!isRecord(config)) {
    return {
      schemaVersion: "client-inventory-summary-v1",
      clientCount: 0,
      clients: [],
      contentReadForSummaryOnly: true,
      rawSecretValuesEmitted: false,
      diagnostics: [
        {
          severity: "error",
          code: "CONFIG_NOT_OBJECT",
          message: "Config root is not an object; no client values were emitted."
        }
      ]
    };
  }

  const inbounds = arrayValue(config.inbounds);
  const clients = inbounds.flatMap((inbound, inboundIndex) => summarizeInboundClients(inbound, inboundIndex));

  if (clients.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "NO_CLIENTS",
      message: "No clients were found in the local config shape."
    });
  }

  return {
    schemaVersion: "client-inventory-summary-v1",
    clientCount: clients.length,
    clients: clients.map((client, clientIndex) => ({
      ...client,
      clientIndex,
      displayName: `Client #${clientIndex + 1}`
    })),
    contentReadForSummaryOnly: true,
    rawSecretValuesEmitted: false,
    diagnostics
  };
}

function summarizeInboundClients(input: unknown, inboundIndex: number): Omit<ClientSummary, "clientIndex" | "displayName">[] {
  const inbound = isRecord(input) ? input : {};
  const settings = isRecord(inbound.settings) ? inbound.settings : {};
  const streamSettings = isRecord(inbound.streamSettings) ? inbound.streamSettings : {};
  const protocol = stringValue(inbound.protocol, "unknown");
  const security = stringValue(streamSettings.security, "unspecified");

  return arrayValue(settings.clients).map((client) => summarizeClient(client, inboundIndex, protocol, security));
}

function summarizeClient(
  input: unknown,
  inboundIndex: number,
  protocol: string,
  security: string
): Omit<ClientSummary, "clientIndex" | "displayName"> {
  const client = isRecord(input) ? input : {};
  const flowPresent = hasNonEmptyString(client.flow);

  return {
    idPresent: hasNonEmptyString(client.id),
    emailPresent: hasNonEmptyString(client.email),
    flowPresent,
    flowTypePresent: flowPresent || hasNonEmptyString(client.flowType),
    inboundIndex,
    protocol,
    security,
    enabledAssumed: true
  };
}

function unwrapXrayConfig(input: unknown): unknown {
  if (isRecord(input) && isRecord(input.xray)) {
    return input.xray;
  }

  return input;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
