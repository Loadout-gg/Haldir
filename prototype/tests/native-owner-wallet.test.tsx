import { expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { prepareOwnerRequest, createNativeOwnerWallet } from '../src/integration/native-owner-wallet'

const approved = { network: 'testnet', owner: 'owner.testnet', mandate: 'j01234567890123456789012345678901.factory.testnet', kind: 'stop', gas: '30000000000000' } as const
const candidate = { network: 'testnet', signerId: 'owner.testnet', receiverId: approved.mandate, methodName: 'stop', args: {}, gas: approved.gas, deposit: '0' } as const

test('unsigned owner stop is an exact native SDK action with explicit wallet approval, not a key shortcut', async () => {
  const request: any = await prepareOwnerRequest(approved, candidate)
  expect(request.id).toBe('near::sign_transactions')
  expect(request.input.target).toEqual({ blockchain: 'near', network: 'testnet', accountId: approved.owner })
  expect(request.input.useFunctionCallKey).toBe(false)
  expect(request.input.transactions).toHaveLength(1)
  const tx = request.input.transactions[0]
  expect(tx.receiverId).toBe(approved.mandate)
  expect(tx.actions).toHaveLength(1)
  expect(tx.actions[0].enum).toBe('functionCall')
  expect(tx.actions[0].functionCall).toMatchObject({ methodName: 'stop', gas: 30000000000000n, deposit: 0n })
  expect(new TextDecoder().decode(tx.actions[0].functionCall.args)).toBe('{}')
})

for (const [name, patch] of Object.entries({
  pay: { methodName: 'pay' }, network: { network: 'mainnet' }, owner: { signerId: 'other.testnet' },
  receiver: { receiverId: 'other.testnet' }, gas: { gas: '30000000000001' }, deposit: { deposit: '1' },
  args: { args: { receiver: 'thief.testnet' } }, extras: { privateKey: 'FORBIDDEN' },
  numeric: { gas: 30000000000000 }, exponent: { gas: '3e13' }, padding: { gas: '030000000000000' },
})) test(`rejects unapproved candidate ${name} before SDK action`, async () => {
  await expect(prepareOwnerRequest(approved as any, { ...candidate, ...patch } as any)).rejects.toThrow()
})

for (const [name, patch] of Object.entries({ mainnet: { network: 'mainnet' }, owner: { owner: 'owner.near' },
  pay: { kind: 'pay' }, overflow: { gas: '18446744073709551616' }, zero: { gas: '0' }, float: { gas: '1.5' },
  receiver: { mandate: 'contract.near' }, wrongOwner: { owner: ' owner.testnet' },
})) test(`rejects invalid independent approval ${name}`, async () => {
  await expect(prepareOwnerRequest({ ...approved, ...patch } as any, candidate as any)).rejects.toThrow()
})

function createPair(owner = 'owner.testnet') {
  const factory = 'factory.testnet', job_label = 'job-1'
  const mandate = 'j' + createHash('sha256').update(owner + ':' + job_label).digest('hex').slice(0, 32) + '.' + factory
  const manifest = { network: 'testnet', kind: 'create', owner, factory, mandate, job_label,
    agent: 'agent.testnet', allowlist: ['vendor.testnet'], cap: '1000000000000000000000000',
    deadline_ns: '1800000000000000000', operating_float: '5000000000000000000000000', gas: '250000000000000' }
  const args = { job_label, agent: manifest.agent, allowlist: manifest.allowlist, cap: manifest.cap, deadline_ns: manifest.deadline_ns, operating_float: manifest.operating_float }
  const call = { network: 'testnet', signerId: owner, receiverId: factory, methodName: 'create_job', args, gas: manifest.gas, deposit: '6000000000000000000000000' }
  return { manifest, call }
}
for (const owner of ['owner.testnet', 'a'.repeat(64)]) test(`create_job ${owner.length === 64 ? 'implicit' : 'named'} keeps exact ABI, decimal strings and derived child`, async () => {
  const { manifest, call } = createPair(owner)
  const request: any = await prepareOwnerRequest(manifest as any, call as any)
  expect(request.input.target.accountId).toBe(owner)
  expect(request.input.useFunctionCallKey).toBe(false)
  const fc = request.input.transactions[0].actions[0].functionCall
  expect(fc.deposit).toBe(6000000000000000000000000n)
  expect(JSON.parse(new TextDecoder().decode(fc.args))).toEqual(call.args)
  expect(fc.methodName).toBe('create_job')
})
for (const [name, patch] of Object.entries({ child: { mandate: 'wrong.factory.testnet' }, roles: { agent: 'owner.testnet' },
  numeric: { cap: 1 }, float: { cap: '1.2' }, overflow: { operating_float: (2n ** 128n).toString() },
  deadline: { deadline_ns: '18446744073709551616' }, cap: { cap: '100000000000000000000000001' },
  gas: { gas: '300000000000001' }, recipients: { allowlist: ['vendor.testnet', 'vendor.testnet'] },
})) test(`rejects malformed create approval ${name}`, async () => {
  const { manifest, call } = createPair()
  await expect(prepareOwnerRequest({ ...manifest, ...patch } as any, call as any)).rejects.toThrow()
})
test('withdraw has no amount or recipient argument and attaches zero', async () => {
  const request: any = await prepareOwnerRequest({ ...approved, kind: 'withdraw' } as any, { ...candidate, methodName: 'withdraw' } as any)
  expect(request.input.transactions[0].actions[0].functionCall.methodName).toBe('withdraw')
})

const principal = () => ({ accountId: 'owner.testnet', networkId: 'testnet', sessionId: 'a'.repeat(64), publicKey: 'ed25519:' + '1'.repeat(32), origin: 'https://approved.invalid', recipient: 'approved.invalid', authenticationOnly: true, expiresAt: Date.now() + 60000 })
for (const scenario of ['hash', 'failure-with-hash', 'cancel', 'timeout', 'missing', 'wrong-signer', 'wrong-receiver', 'wrong-network', 'changed-session', 'double-click']) test(`explicit wallet boundary ${scenario}`, async () => {
  let loads = 0, prompts = 0, reads = 0, release: (() => void) | undefined
  let session: any = principal()
  const wallet = createNativeOwnerWallet({ principal: () => session, loadMeteor: async () => { loads++; return {
    getAccount: async target => { reads++; return { identifier: { ...target, network: scenario === 'wrong-network' ? 'mainnet' : 'testnet' } } },
    createAction: async request => {
      expect(request.input.useFunctionCallKey).toBe(false)
      return { promptForExecution: async () => {
        prompts++
        if (scenario === 'cancel') throw new Error('Action was cancelled')
        if (scenario === 'timeout') throw new Error('transport lost after send')
        if (scenario === 'changed-session') session = { ...session, sessionId: 'b'.repeat(64) }
        if (scenario === 'double-click') await new Promise<void>(resolve => { release = resolve })
        return scenario === 'missing' ? [] : [{ transaction: { hash: '1'.repeat(32), signer_id: scenario === 'wrong-signer' ? 'thief.testnet' : 'owner.testnet', receiver_id: scenario === 'wrong-receiver' ? 'thief.testnet' : candidate.receiverId }, status: scenario === 'failure-with-hash' ? { Failure: {} } : { SuccessValue: '' } }]
      } }
    },
  } } })
  expect(loads).toBe(0)
  const promise = wallet.approve(approved as any, candidate as any)
  if (scenario === 'double-click') {
    await expect(wallet.approve(approved as any, candidate as any)).resolves.toMatchObject({ status: 'blocked' })
    while (!release) await new Promise(resolve => setTimeout(resolve, 0))
    release()
  }
  const result = await promise
  const submitted = ['hash', 'failure-with-hash', 'double-click'].includes(scenario)
  expect(result.status).toBe(submitted ? 'submitted' : scenario === 'cancel' ? 'cancelled' : scenario === 'wrong-network' ? 'blocked' : 'unknown')
  expect(result.transactionHash).toBe(submitted || scenario === 'changed-session' ? '1'.repeat(32) : null)
  expect(result.status).not.toBe('success')
  expect(prompts).toBe(scenario === 'wrong-network' ? 0 : 1)
  expect(reads).toBeGreaterThan(0)
})
test('expired or foreign session never loads wallet or prompts', async () => {
  let loads = 0
  for (const p of [null, { ...principal(), expiresAt: 0 }, { ...principal(), accountId: 'other.testnet' }, { ...principal(), networkId: 'mainnet' }]) {
    const wallet = createNativeOwnerWallet({ principal: () => p as any, loadMeteor: async () => { loads++; throw new Error('forbidden') } })
    expect((await wallet.approve(approved as any, candidate as any)).status).toBe('blocked')
  }
  expect(loads).toBe(0)
})
