/**
 * Claude беті ұсынатын мүмкіндіктер: db (деректер базасы), user (кім қарап тұр), artifact (бетті жариялау).
 * Claude-қа кірмеген клиентте db болмайды — ол тек беттің ішіндегі жария күйді көреді.
 */
export const runtime = {
  db: null,
  user: null,
  artifact: null,
  /** Бетті өзгерте алатын адам (иесі немесе редактор) — әкімші интерфейсі соған ғана. */
  isAdmin: false,
};

async function waitForClaude(ms = 10_000) {
  const started = Date.now();
  while (!window.claude?.use) {
    if (Date.now() - started > ms) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
  return window.claude;
}

async function use(claude, name) {
  try {
    return await Promise.race([claude.use(name), new Promise((resolve) => setTimeout(() => resolve(null), 10_000))]);
  } catch {
    return null;
  }
}

export const ready = (async () => {
  const claude = await waitForClaude();
  if (!claude) return runtime;
  const [user, artifact] = await Promise.all([use(claude, 'user'), use(claude, 'artifact')]);
  runtime.user = user;
  runtime.artifact = artifact;
  runtime.isAdmin = user ? Boolean(await user.canEdit().catch(() => false)) : false;
  if (runtime.isAdmin) runtime.db = await use(claude, 'db');
  return runtime;
})();
