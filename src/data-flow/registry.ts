import type {
  DataFlowDiagnostic,
  DataFlowOverlay,
  DataFlowProjectContext,
  DataFlowProvider,
} from './provider.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerFailure(
  providerId: string,
  phase: 'support-check' | 'extraction',
  error: unknown,
): DataFlowDiagnostic {
  return {
    providerId,
    severity: 'error',
    code: `provider-${phase}-failed`,
    message: `Data-flow provider "${providerId}" failed during ${phase}: ${errorMessage(error)}`,
  };
}

async function runProvider(
  provider: DataFlowProvider,
  context: DataFlowProjectContext,
): Promise<DataFlowOverlay> {
  let supported: boolean;
  try {
    supported = await provider.supports(context);
  } catch (error) {
    return { nodes: [], edges: [], diagnostics: [providerFailure(provider.id, 'support-check', error)] };
  }

  if (!supported) return { nodes: [], edges: [], diagnostics: [] };

  try {
    return await provider.extract(context);
  } catch (error) {
    return { nodes: [], edges: [], diagnostics: [providerFailure(provider.id, 'extraction', error)] };
  }
}

function mergeOverlays(overlays: DataFlowOverlay[]): DataFlowOverlay {
  const nodes = new Map<string, DataFlowOverlay['nodes'][number]>();
  const edges = new Map<string, DataFlowOverlay['edges'][number]>();
  const diagnostics: DataFlowDiagnostic[] = [];

  for (const overlay of overlays) {
    for (const node of overlay.nodes) {
      if (!nodes.has(node.id)) nodes.set(node.id, node);
    }
    for (const edge of overlay.edges) {
      if (!edges.has(edge.id)) edges.set(edge.id, edge);
    }
    diagnostics.push(...overlay.diagnostics);
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], diagnostics };
}

export class DataFlowProviderRegistry {
  readonly #providers = new Map<string, DataFlowProvider>();

  constructor(providers: DataFlowProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: DataFlowProvider): void {
    if (this.#providers.has(provider.id)) {
      throw new Error(`Data-flow provider "${provider.id}" is already registered.`);
    }
    this.#providers.set(provider.id, provider);
  }

  list(): readonly DataFlowProvider[] {
    return [...this.#providers.values()];
  }

  async extract(context: DataFlowProjectContext): Promise<DataFlowOverlay> {
    const overlays = await Promise.all(this.list().map((provider) => runProvider(provider, context)));
    return mergeOverlays(overlays);
  }
}
