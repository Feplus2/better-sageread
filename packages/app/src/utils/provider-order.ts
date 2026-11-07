const LOCAL_PROVIDER_IDS = new Set(["ollama", "lmstudio"]);

export function orderModelProviders<T extends { provider: string }>(providers: T[]): T[] {
  return providers
    .map((provider, index) => ({ provider, index }))
    .sort(
      (left, right) =>
        Number(LOCAL_PROVIDER_IDS.has(left.provider.provider)) -
          Number(LOCAL_PROVIDER_IDS.has(right.provider.provider)) || left.index - right.index,
    )
    .map(({ provider }) => provider);
}
