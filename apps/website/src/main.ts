import "./style.css";

const arrow = '<span aria-hidden="true">↗</span>';

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div class="page-shell">
    <header>
      <a class="wordmark" href="/" aria-label="envkit home"><span class="brand-icon" aria-hidden="true">e<span>_</span></span>envkit<span class="brand-dot">.</span></a>
      <nav aria-label="Main navigation">
        <a href="https://docs.envkit.dev">Docs ${arrow}</a>
        <a href="https://github.com/bachubila/envkit">GitHub ${arrow}</a>
      </nav>
    </header>

    <main id="main">
      <section class="hero" aria-labelledby="headline">
        <div class="intro">
          <a class="release" href="https://github.com/bachubila/envkit"><span class="status-dot"></span> Open source · In development <span aria-hidden="true">→</span></a>
          <h1 id="headline">Your vault.<br>Your variables.<br><span>Everyone in sync.</span></h1>
          <p class="description">Environment variables for your team, powered by the Vaultwarden server you already host.</p>
          <div class="actions">
            <a class="button primary" href="https://docs.envkit.dev">Read the docs <span aria-hidden="true">→</span></a>
            <a class="source-link" href="https://github.com/bachubila/envkit">Explore the source ${arrow}</a>
          </div>
          <p class="hero-note">Your infrastructure. Your access rules. One small CLI.</p>
        </div>

        <div class="terminal-wrap">
          <div class="terminal" aria-label="Example envkit workflow">
            <div class="terminal-header"><span class="terminal-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>~/your-next-project</span><span class="terminal-type">zsh</span></div>
            <div class="terminal-body">
              <p class="comment"># Bring your existing .env</p>
              <p class="command"><span class="prompt">❯</span> envkit push --from .env</p>
              <p class="terminal-note">Keep variables in your team's vault.</p>
              <div class="terminal-divider"></div>
              <p class="comment"># Give your app what it needs</p>
              <p class="command"><span class="prompt">❯</span> envkit run -- npm start</p>
              <div class="variable-list" aria-hidden="true"><span>DATABASE_URL</span><span>••••••••••••</span><span>API_KEY</span><span>••••••••••••</span><span>APP_SECRET</span><span>••••••••••••</span></div>
              <p class="terminal-caption"><span class="status-dot"></span> Secrets stay out of your source code.</p>
              <p class="command cursor-line" aria-hidden="true"><span class="prompt">❯</span> <span class="cursor"></span></p>
            </div>
          </div>
          <div class="terminal-footnote"><span aria-hidden="true">↳</span> dev, staging, prod. Same workflow.</div>
        </div>
      </section>

      <section class="features" aria-label="Why envkit">
        <article><span class="feature-number">01 / YOUR VAULT</span><h2>Already at home.</h2><p>Use your Vaultwarden organizations, collections, and permissions. No new secrets service.</p></article>
        <article><span class="feature-number">02 / YOUR WORKFLOW</span><h2>One command away.</h2><p>Inject variables directly into your app. Encrypted local storage keeps everyday reads fast.</p></article>
        <article><span class="feature-number">03 / YOUR TEAM</span><h2>Local to CI.</h2><p>Share environments with teammates and use read-only accounts in CI. Values are masked in GitHub Actions logs.</p></article>
      </section>
      <section class="workflow" aria-labelledby="workflow-title">
        <div class="section-heading">
          <span class="feature-number">THE EVERYDAY WORKFLOW</span>
          <h2 id="workflow-title">From .env to everyone.</h2>
          <p>Set up the project once. Give your team access. Keep using the commands you already know.</p>
        </div>
        <ol class="steps">
          <li><span class="step-index">01</span><div><h3>Connect your vault.</h3><p>Sign in to your Vaultwarden server with your existing account. envkit talks to it directly; the Bitwarden CLI is optional.</p><pre><code>envkit login --server https://vault.example.com</code></pre></div></li>
          <li><span class="step-index">02</span><div><h3>Bring your environments.</h3><p>Create a project and upload your variables. Each project gets a collection, with a separate vault item for each environment.</p><pre><code>envkit init --project my-app --env dev,staging,prod
envkit push --from .env</code></pre></div></li>
          <li><span class="step-index">03</span><div><h3>Run something good.</h3><p>Commit the generated .envkit.json. It contains IDs only, so teammates can use the same project without putting secrets in Git.</p><pre><code>envkit run -- npm start
envkit run -e staging -- npm run migrate</code></pre></div></li>
        </ol>
      </section>

      <section class="details" aria-label="Built for everyday development">
        <div class="detail-card">
          <span class="feature-number">LESS ENVIRONMENT GUESSWORK</span>
          <h2>Know what changed.</h2>
          <p>Compare variable names across environments, preview uploads, and pull your teammates’ latest changes when you need them.</p>
          <div class="command-pairs"><code>envkit diff dev prod</code><span>Find missing keys</span><code>envkit push --from .env</code><span>Preview before writing</span><code>envkit sync</code><span>Fetch the latest values</span></div>
        </div>
        <div class="detail-card">
          <span class="feature-number">ACCESS THAT ALREADY MAKES SENSE</span>
          <h2>One team. Clear boundaries.</h2>
          <p>Grant access through your vault’s collection permissions. Read-only access is enough to run an app; CI can use a dedicated account with an API key.</p>
          <p class="detail-secondary">An encrypted local copy keeps reads fast. Sessions use your OS keychain and lock after 60 idle minutes by default.</p>
          <a class="source-link" href="https://docs.envkit.dev">Explore setup and CI ${arrow}</a>
        </div>
      </section>

      <section class="closing" aria-labelledby="closing-title">
        <div><span class="feature-number">SMALL TOOL. SHARED SOURCE OF TRUTH.</span><h2 id="closing-title">Make yourself at home.</h2><p>envkit is open source and in development. You can build from source today, follow along, or help shape what comes next.</p><p class="requirements">Requires Node.js 22.18+ and a Vaultwarden server over HTTPS.</p></div>
        <div class="closing-actions"><a class="button primary" href="https://github.com/bachubila/envkit">Find us on GitHub ${arrow}</a><a class="source-link" href="mailto:mail@envkit.dev">mail@envkit.dev ${arrow}</a></div>
      </section>
    </main>

    <footer><p>Less passing secrets. More shipping.</p><div><span class="license">Open source / MIT</span><a href="mailto:mail@envkit.dev">Get in touch ${arrow}</a></div></footer>
  </div>
`;
