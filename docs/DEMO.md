# Haldir demo guide

[Back to Haldir](../README.md)

## What you are about to try

Open [haldir.ldt.sh/demo](https://haldir.ldt.sh/demo), or run the [local frontend](VALIDATION.md) and open `/demo`.

This is a **scripted simulation** of one research job. The company, email, sources, receipts and TEST currency are fictional. You do not need a wallet or funds. The visible **Demo controls** let a presenter advance events that would otherwise come from funding, execution and delivery systems. They are not evidence of a live autonomous agent.

The separate `/app` workspace is not the presenter-driven demo. Connecting a wallet there does not activate financial execution.

## Walkthrough: do this, observe that

Send this exact initial message in the scripted demo:

```text
job Check Northwind Print before I sign; output A short brief with evidence and purchase receipts; budget 30; expiry 2026-11-12T18:00
```

Budget and expiry are initially blank. This message supplies them explicitly; the expiry is valid relative to the simulation’s fixed clock, not today’s wall clock. Keep both recipients selected. If you use your own message instead, complete every missing field in **Edit details** before authorization.

| Step | Action | Expected observation |
| --- | --- | --- |
| 1. Prepare | Send the exact message above. | A proposal appears with the supplied job, output, 30 TEST cap and fixture expiry, not an active spending permission. The fictional email is already available. |
| 2. Review | Use **Edit details** to inspect or complete the fields, then review the spending limits. Keep the canonical 30 TEST scenario and both recipients for this walkthrough. | Job, output, cap, UTC expiry and allowed recipients can be inspected together. |
| 3. Authorize | Select **Authorize mandate**, then use presenter **Confirm funding**. | Funding pending and active work are distinct states. No real signature or transfer occurs. |
| 4. Get useful evidence | Advance **S03** in Demo controls. | Company records arrive for 8 TEST. Open evidence and the purchase receipt separately. The other source is still pending; totals are 8 spent / 0 reserved / 22 available. |
| 5. Inspect the small extra | Advance **S04**, then open **View details**. | A 2 TEST request to a recipient outside the mandate is blocked. Enough funds exist, but the recipient is not allowed. Earlier evidence and totals remain. |
| 6. Inspect reservation behavior | Advance **S05**. | This presenter event includes two 15 TEST requests: one reserves funds and the other is refused. Totals are 8 / 15 / 7. This is deterministic simulation, not proof of real network concurrency. |
| 7. Finish the approved source | Advance **S06**. | The second source is paid and delivered. Totals are 23 / 0 / 7. The available-evidence preview and **Open partial brief** remain explicitly partial. They do not display a completed backend report. |
| 8. Close spending | Select **Stop new spending**, then presenter **Confirm stop**. Use **Check prior payments**, **Recover 7 TEST**, then presenter **Confirm return**. | Stop requested is not stop confirmed; free funds are not yet recovered. Final simulated totals are 23 spent, 7 recovered, 0 reserved and 0 available. |

The `Continue without this purchase` control dismisses the explanation; it must not be staged as mandatory approval for the already permitted work. The presenter controls are a different mechanism from that consumer action.

### Important filming distinction

The product story is “useful purchase → excluded recipient blocked → approved work continues.” The current S05 presenter event adds a separate budget-conflict demonstration. Do not describe it as a single isolated second purchase, and do not cut around it in a way that makes the visible state or counters misleading. A version with an isolated second-purchase event must be explicitly implemented and checked before filming that shorter path.

Use actual labels from the version being recorded. Mockup copy alone does not establish that an interaction exists in the running version.

## Separate the browser preview from the backend report

The current browser demo shows placeholder source content and **“Available evidence preview · Partial, not final”**. Its partial-brief reader explicitly says there is no final brief or signing assurance. Do not expect the following richer findings to appear in that walkthrough.

The separate backend fixtures and runner tests exercise a more useful Northwind report:

- compare the declared company details across the two sources;
- identify information that is self-reported or unverified;
- identify the missing certification evidence;
- request the certificate number, issuer and expiry before signing.

That backend result is an evidence brief, not a certification, legal opinion or guarantee that a supplier is trustworthy. Reproduce it with the focused test command in the [validation guide](VALIDATION.md); the Northwind test emits its fictional report. This is not a claim that the report is integrated into the public browser demo.

## Limits of this mode

- No real mailbox, model inference, payment, wallet signature or chain receipt.
- The simulation is in memory; reloading resets it. This is not durable backend recovery.
- The deterministic fixture clock starts at **12 November 2026, 12:00 UTC**, with a default expiry of **18:00 UTC**. It does not follow your computer's clock. Interpret expiry demonstrations against that fixture clock.
- Editing the budget or recipients changes the story. A larger cap may admit a request that the canonical example refuses.
- Stopping new spending does not reverse completed purchases. Reset is a new fictional replay, not a refund or amendment.
- A useful-looking result does not establish source accuracy or live enforcement.

## Recording and review

Start inside the product, with the user's task. Show readable close-ups of authorization, the first useful evidence, the excluded recipient and the final result. Keep permission, payment, delivery and return confirmations distinct.

Label simulated segments visibly. A separate real NEAR demonstration should name its environment and provide authentic evidence; do not overlay a transaction hash or a “confirmed” label to make a simulation look real.

Useful feedback is specific: which permission was unclear, whether the blocked request looked as though it halted the whole job, whether an earlier result disappeared, and whether the viewer can explain why funds were available but the extra payment was still forbidden.
