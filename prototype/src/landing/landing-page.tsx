/* THESIS: Useful work with explicit spending boundaries, not a wallet landing.
 * OWN-WORLD: Incumbent Haldir mark, system type, near-white canvas, Forest actions,
 * white 14px groups and quiet separators. No new identity or generated imagery.
 * STORY: Understand the job, read a fictional example, then choose a labelled route.
 * FIRST VIEWPORT: Brand/navigation, editorial promise and one illustrative job view;
 * the reading CTA and inactive-prototype status stay next to the promise.
 * FORM: Existing seven-section brief, in its supplied order; no concept roll.
 * Persuade surface. Local implementation is not human visual approval. */
import haldirLogo from '../assets/haldir/logo-horizontal.png'
import { buttonVariants } from '../components/ui/base-nova/button'
import { Card, CardContent, CardHeader } from '../components/ui/base-nova/card'
import './landing.css'

export default function LandingPage() {
  return (
    <div className="haldir-landing">
      <a className="landing-skip" href="#landing-main">Skip to content</a>
      <header className="landing-header">
        <a className="landing-logo" href="/" aria-label="Haldir home"><img src={haldirLogo} width="108" height="34" alt="Haldir" /></a>
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#demo">Demo</a>
          <a href="#near">Why NEAR</a>
        </nav>
        <a className={buttonVariants()} href="#demo">Explore the demo</a>
      </header>
      <main id="landing-main" tabIndex={-1}>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div>
            <p className="landing-eyebrow">AI work. Defined spending permissions.</p>
            <h1 id="landing-title">Give AI a job. Keep control of its spending.</h1>
            <p className="landing-intro">Haldir is designed to let an AI agent buy the information it needs for a job, within a budget, an expiry and a list of recipients you approve. Follow the work, see what each purchase delivers, and keep the spending rules separate from the model.</p>
            <a className={buttonVariants()} href="#demo">Explore the demo</a>
            <p className="landing-status">Hackathon prototype in development. Financial actions are disabled.</p>
          </div>
          <figure className="landing-product-view" aria-label="Illustrative product view">
            <p className="landing-label">Illustrative product view</p>
            <Card className="landing-product-card">
              <CardHeader><p className="landing-product-title">Supplier check</p><p className="landing-product-subtitle">The work and its spending boundaries</p></CardHeader>
              <CardContent className="landing-product-body">
                <div className="landing-product-conversation">
                  <p className="landing-product-request">Check Northwind Print before I sign a supplier contract.</p>
                  <div className="landing-product-result"><p>Company records</p><p>Information and purchase receipt</p><p className="landing-product-amount">Illustrative purchase · 8 TEST</p></div>
                  <p className="landing-product-continuation">No action needed. Continuing with approved sources.</p>
                </div>
                <div className="landing-product-permissions">
                  <p className="landing-product-title">Spending permissions</p>
                  <dl><div><dt>Budget</dt><dd>30 TEST</dd></div><div><dt>Recipients</dt><dd>2 approved providers</dd></div><div><dt>Expiry</dt><dd>Owner-defined</dd></div></dl>
                  <dl className="landing-product-ledger"><div><dt>Spent</dt><dd>8 TEST</dd></div><div><dt>Reserved</dt><dd>0 TEST</dd></div><div><dt>Available</dt><dd>22 TEST</dd></div></dl>
                </div>
              </CardContent>
            </Card>
            <figcaption>Fictional example, not a live product screenshot.</figcaption>
          </figure>
        </section>
        <section id="how-it-works" className="landing-section" aria-labelledby="how-heading">
          <div className="landing-section-heading">
            <h2 id="how-heading">One job. Clear permissions.</h2>
            <p>Describe the outcome you need. Review the spending permissions before the agent starts.</p>
          </div>
          <ol className="landing-steps">
            <li><h3>Describe the job</h3><p>Tell the assistant what you need and provide the relevant context. Refine the same draft through conversation or direct edits.</p></li>
            <li><h3>Approve the boundaries</h3><p>Review the budget, expiry and allowed recipients. Spending starts only after the required authorization and funding confirmations.</p></li>
            <li><h3>Follow the outcome</h3><p>See the information received, its purchase receipts and any blocked requests without reconstructing the conversation.</p></li>
          </ol>
        </section>

        <section id="demo" className="landing-section landing-demo" aria-labelledby="demo-heading">
          <div className="landing-section-heading">
            <p className="landing-label">The illustrative demo</p>
            <h2 id="demo-heading">Within budget doesn't mean authorized.</h2>
            <p>A procurement lead asks an agent to check Northwind Print before signing a supplier contract. The job has a 30 TEST budget and two approved information providers.</p>
          </div>
          <ol className="landing-scenario">
            <li><span className="landing-beat" aria-hidden="true">1</span><div><h3>Useful work first</h3><p>The first authorized purchase costs 8 TEST. In this example, the information and its receipt become available for the supplier brief.</p></div><span className="landing-scenario-fact">8 TEST purchase</span></li>
            <li><span className="landing-beat" aria-hidden="true">2</span><div><h3>A small request, outside the rules</h3><p>A fictional email asks for another 2 TEST to finish the check. The amount fits the remaining budget, but the requested recipient is not authorized.</p></div><span className="landing-scenario-fact">2 TEST request</span></li>
            <li><span className="landing-beat" aria-hidden="true">3</span><div><h3>Block the payment, continue the job</h3><p>The intended response: reject that payment, explain why, and continue with permitted work. The blocked request does not grant new spending permissions.</p></div><span className="landing-scenario-fact landing-blocked">Payment blocked</span></li>
          </ol>
          <p className="landing-caption">Illustrative scenario. Company, providers, email and TEST amounts are fictional. Network fees are separate. Live financial enforcement is still being qualified.</p>
          <div className="landing-route-links">
            <a className={buttonVariants({ variant: 'outline' })} href="/demo">Open scripted simulation</a>
            <span>Fictional, interactive walkthrough. No wallet or real funds.</span>
          </div>
        </section>

        <section className="landing-section landing-outcome" aria-labelledby="outcome-heading">
          <div className="landing-section-heading">
            <h2 id="outcome-heading">The result, the receipts and the limits. Together.</h2>
            <p>Haldir is designed to bring the job and its spending into the same workspace: what the agent obtained, what it paid for, and what it could not purchase.</p>
          </div>
          <dl className="landing-control-list">
            <div><dt>Evidence linked to purchases</dt><dd>Keep delivered information and payment receipts connected. A successful payment is not the same as a delivered result.</dd></div>
            <div><dt>Spending you can read</dt><dd>Distinguish spent, reserved and available funds. Show recovered funds only after recovery is confirmed.</dd></div>
            <div><dt>A clear way to stop</dt><dd>Request a stop to new spending, track confirmation and resolve pending operations before recovering free funds. Closing the chat is not the same as stopping spending.</dd></div>
          </dl>
          <p className="landing-caption">These are intended product behaviors, not a claim of a completed live financial journey.</p>
        </section>

        <section id="near" className="landing-section landing-near" aria-labelledby="near-heading">
          <div className="landing-section-heading">
            <p className="landing-label">Why NEAR</p>
            <h2 id="near-heading">Spending permissions should not depend on a prompt.</h2>
            <p>Haldir uses a native NEAR testnet design: the owner wallet authorizes the spending mandate, while the agent works within its defined boundaries. The goal is to apply owner-approved spending rules outside the AI model, rather than relying on instructions in a conversation.</p>
            <p>The current hosted prototype has financial actions disabled. The scripted simulation illustrates the intended behavior; it is not evidence of live on-chain enforcement.</p>
          </div>
          <div className="landing-route-links">
            <a className={buttonVariants({ variant: 'outline' })} href="/app">Open testnet workspace</a>
            <span>Prototype workspace. Financial actions are disabled.</span>
          </div>
        </section>

        <section className="landing-section landing-questions" aria-labelledby="questions-heading">
          <h2 id="questions-heading">Essential questions</h2>
          <dl>
            <div><dt>Can the agent give itself more spending permission?</dt><dd>The product is designed around permissions approved by the owner. Changing them requires explicit re-authorization; an email or chat message is not permission to pay a new recipient.</dd></div>
            <div><dt>Does a blocked purchase stop the whole job?</dt><dd>Not by itself. The intended behavior is to continue with permitted work and show what was not purchased. If missing information prevents a complete result, that limitation should remain visible.</dd></div>
            <div><dt>Does Haldir guarantee the quality of the result?</dt><dd>No. Spending controls limit purchasing authority. They do not guarantee that purchased information is accurate or that the agent's conclusion is correct.</dd></div>
            <div><dt>Does the demo connect to my inbox?</dt><dd>The depicted workflow assumes email access has already been arranged. It uses fictional messages; a live mailbox integration has not been verified for this demo.</dd></div>
          </dl>
        </section>

        <section className="landing-section landing-closing" aria-labelledby="closing-heading">
          <div><h2 id="closing-heading">Delegate the work. Define the spending.</h2><p>See how a useful result and clear spending boundaries fit into the same job.</p></div>
          <a className={buttonVariants()} href="#demo">Explore the demo</a>
        </section>
      </main>
      <footer className="landing-footer"><p>Haldir · Hackathon prototype</p><p>Illustrative examples. No live financial execution.</p></footer>
    </div>
  )
}
