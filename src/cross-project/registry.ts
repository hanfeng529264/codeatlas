import type {
  CrossProjectContext,
  CrossProjectOverlay,
  CrossProjectProvider,
} from './provider.js';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CrossProjectProviderRegistry {
  readonly #providers = new Map<string, CrossProjectProvider>();

  constructor(providers: CrossProjectProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: CrossProjectProvider): void {
    if (this.#providers.has(provider.id)) {
      throw new Error(`Cross-project provider "${provider.id}" is already registered.`);
    }
    this.#providers.set(provider.id, provider);
  }

  async extract(context: CrossProjectContext): Promise<CrossProjectOverlay> {
    const edges = new Map<string, CrossProjectOverlay['edges'][number]>();
    const diagnostics: CrossProjectOverlay['diagnostics'] = [];
    for (const provider of this.#providers.values()) {
      try {
        if (!(await provider.supports(context))) continue;
        const overlay = await provider.extract(context);
        for (const edge of overlay.edges) {
          edges.set(`${edge.source}\u0000${edge.target}\u0000${edge.kind}`, edge);
        }
        diagnostics.push(...overlay.diagnostics);
      } catch (error) {
        diagnostics.push({
          providerId: provider.id,
          severity: 'error',
          code: 'cross-project-provider-failed',
          message: `Cross-project provider "${provider.id}" failed: ${message(error)}`,
        });
      }
    }
    return { edges: [...edges.values()], diagnostics };
  }
}
