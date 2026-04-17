const app = document.getElementById('app')!;

app.innerHTML = `
  <header class="topbar">
    <strong>Acme Dashboard</strong>
    <span class="badge" data-testid="env-badge">DEV</span>
  </header>
  <main>
    <section class="card">
      <h1 id="dashboard-title">Welcome back, Maria.</h1>
      <p class="lead" id="lead-text">
        You have <strong>3 open tasks</strong> and <strong>2 messages</strong>.
      </p>
      <div class="row">
        <button class="primary" id="start-btn">Start your day</button>
        <button class="secondary" id="snooze-btn">Snooze 15m</button>
      </div>
    </section>

    <section class="card">
      <h2>Tasks</h2>
      <ul id="tasks">
        <li><input type="checkbox" aria-label="task 1"> Respond to claims audit email</li>
        <li><input type="checkbox" aria-label="task 2"> Review referrals queue</li>
        <li><input type="checkbox" aria-label="task 3"> Confirm next week's schedule</li>
      </ul>
    </section>

    <section class="card notice">
      <p>
        This is the <strong>dev-server</strong> demo — edit
        <code>demos/dev-server/src/main.ts</code> and Vite HMR will update the DOM.
        Open the widget, comment on any element, then change the source — your
        pins should follow the DOM.
      </p>
    </section>
  </main>
`;

document.getElementById('start-btn')?.addEventListener('click', () => {
  alert('Started! (This is a mock.)');
});
