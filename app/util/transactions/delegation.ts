import { decode } from '@metamask/abi-utils';
import {
  AuthorizationList,
  NestedTransactionMetadata,
  TransactionMeta,
  decodeAuthorizationSignature,
} from '@metamask/transaction-controller';
import {
  BATCH_DEFAULT_MODE,
  BATCH_TRY_MODE,
  Caveat,
  DeleGatorEnvironment,
  ExecutionMode,
  ExecutionStruct,
  SINGLE_DEFAULT_MODE,
  SINGLE_TRY_MODE,
  createCaveatBuilder,
  getDeleGatorEnvironment,
} from '../../core/Delegation';
import {
  ANY_BENEFICIARY,
  Delegation,
  REDEEM_DELEGATIONS_SELECTOR,
  UnsignedDelegation,
  createDelegation,
  encodeRedeemDelegations,
} from '../../core/Delegation/delegation';
import { Hex, add0x, bytesToHex, createProjectLogger, remove0x } from '@metamask/utils';
import { limitedCalls } from '../../core/Delegation/caveatBuilder/limitedCallsBuilder';
import { Messenger } from '@metamask/messenger';
import { DelegationControllerSignDelegationAction } from '@metamask/delegation-controller';
import { KeyringControllerSignEip7702AuthorizationAction } from '@metamask/keyring-controller';
import { toHex } from '@metamask/controller-utils';
import Engine from '../../core/Engine';
import { exactExecutionBatch } from '../../core/Delegation/caveatBuilder/exactExecutionBatchBuilder';
import { exactExecution } from '../../core/Delegation/caveatBuilder/exactExecutionBuilder';

const log = createProjectLogger('transaction-delegation');

export type SignMessenger = Messenger<
  string,
  | DelegationControllerSignDelegationAction
  | KeyringControllerSignEip7702AuthorizationAction,
  never
>;

export interface AuthorizationRequest {
  upgradeContractAddress?: Hex;
}

export interface ConvertTransactionToRedeemDelegationsRequest {
  transaction: TransactionMeta;
  messenger: SignMessenger;
  caveats?: Caveat[];
  additionalExecutions?: ExecutionStruct[];
  delegatee?: Hex;
  delegationSignature?: Hex;
  authorization?: AuthorizationRequest;
}

export interface ConvertTransactionToRedeemDelegationsResult {
  authorizationList?: AuthorizationList;
  data: Hex;
  to: Hex;
}

interface RedeemDelegationCall {
  delegations: Delegation[][];
  modes: ExecutionMode[];
  executions: ExecutionStruct[][];
}

const SELECTOR_HEX_CHARS = 8;

export async function convertTransactionToRedeemDelegations(
  request: ConvertTransactionToRedeemDelegationsRequest,
): Promise<ConvertTransactionToRedeemDelegationsResult> {
  const { transaction, messenger } = request;
  const { chainId } = transaction;
  const delegationEnvironment = getDeleGatorEnvironment(parseInt(chainId, 16));
  const delegationManagerAddress = delegationEnvironment.DelegationManager as Hex;

  const sourceCalls = extractCalls(transaction);

  const { regular, inner } = partitionCalls(
    sourceCalls,
    delegationManagerAddress,
  );

  if (inner.length > 0) {
    log('Flattening inner redeemDelegations slots', {
      innerCount: inner.length,
      regularCount: regular.length,
    });
  }

  const defaultExecutions: ExecutionStruct[] = regular.map(callToExecution);
  const additionalExecutions = request.additionalExecutions ?? [];
  const allExecutions: ExecutionStruct[] = [...defaultExecutions, ...additionalExecutions];

  const hasOuterSlots = allExecutions.length > 0;

  const authorizationList = request.authorization
    ? await buildAuthorizationList(transaction, messenger, request.authorization)
    : undefined;

  if (!hasOuterSlots && inner.length === 0) {
    return {
      authorizationList,
      data: '0x' as Hex,
      to: delegationManagerAddress,
    };
  }

  if (!hasOuterSlots && inner.length === 1) {
    log('Using single inner redeemDelegations call directly');
    return {
      authorizationList,
      data: inner[0],
      to: delegationManagerAddress,
    };
  }

  const innerDecoded = inner.map(decodeRedeemDelegationsPayload);

  const outerTransaction: TransactionMeta = {
    ...transaction,
    nestedTransactions: regular.map(callToNestedTransaction),
  };

  const outerDelegations = hasOuterSlots
    ? await signAndWrapDelegation({
        transaction: outerTransaction,
        caveats: request.caveats ?? buildDefaultCaveats(delegationEnvironment, allExecutions),
        messenger,
        delegatee: request.delegatee,
        delegationSignature: request.delegationSignature,
      })
    : [];

  const outerMode: ExecutionMode | undefined = hasOuterSlots
    ? allExecutions.length > 1
      ? BATCH_DEFAULT_MODE
      : SINGLE_DEFAULT_MODE
    : undefined;

  const delegations = [
    ...(hasOuterSlots ? outerDelegations : []),
    ...innerDecoded.flatMap((d) => d.delegations),
  ];
  const modes = [
    ...(outerMode ? [outerMode] : []),
    ...innerDecoded.flatMap((d) => d.modes),
  ];
  const executions = [
    ...(hasOuterSlots ? [allExecutions] : []),
    ...innerDecoded.flatMap((d) => d.executions),
  ];

  log('Built redeemDelegations call', { delegations, modes, executions });

  const data = encodeRedeemDelegations({ delegations, modes, executions });

  return {
    authorizationList,
    data,
    to: delegationManagerAddress,
  };
}

interface Call {
  to?: Hex;
  value?: Hex;
  data?: Hex;
}

function extractCalls(transaction: TransactionMeta): Call[] {
  const { nestedTransactions, txParams } = transaction;

  if (nestedTransactions?.length && nestedTransactions[0].to) {
    return nestedTransactions.map((tx) => ({
      to: tx.to as Hex | undefined,
      value: tx.value as Hex | undefined,
      data: tx.data as Hex | undefined,
    }));
  }

  if (!txParams.to) {
    return [];
  }

  return [
    {
      to: txParams.to as Hex,
      value: (txParams.value as Hex | undefined) ?? '0x0',
      data: txParams.data as Hex | undefined,
    },
  ];
}

function partitionCalls(
  calls: Call[],
  delegationManagerAddress: Hex,
): { regular: Call[]; inner: Hex[] } {
  const regular: Call[] = [];
  const inner: Hex[] = [];

  for (const call of calls) {
    if (isRedeemDelegationsCall(call, delegationManagerAddress)) {
      inner.push(call.data as Hex);
    } else {
      regular.push(call);
    }
  }

  return { regular, inner };
}

function isRedeemDelegationsCall(
  call: Call,
  delegationManagerAddress: Hex,
): boolean {
  const { data, to } = call;
  return Boolean(
    data &&
      to &&
      to.toLowerCase() === delegationManagerAddress.toLowerCase() &&
      data.toLowerCase().startsWith(REDEEM_DELEGATIONS_SELECTOR),
  );
}

function callToExecution(call: Call): ExecutionStruct {
  return {
    target: call.to as Hex,
    value: BigInt(call.value ?? '0x0'),
    callData: normalizeCallData(call.data),
  };
}

function callToNestedTransaction(call: Call): NestedTransactionMetadata {
  return {
    to: call.to,
    value: call.value,
    data: call.data,
  } as NestedTransactionMetadata;
}

function decodeRedeemDelegationsPayload(callData: Hex): RedeemDelegationCall {
  const payload = `0x${remove0x(callData).slice(SELECTOR_HEX_CHARS)}` as Hex;

  const [rawContexts, rawModes, rawCalldatas] = decode(
    ['bytes[]', 'bytes32[]', 'bytes[]'],
    payload,
  ) as [Uint8Array[], Uint8Array[], Uint8Array[]];

  const modes = rawModes.map((m) => toHexBytes(m) as ExecutionMode);
  const delegations = rawContexts.map((ctx) => decodePermissionContext(ctx));
  const executions = rawCalldatas.map((cd, i) =>
    decodeExecutionCalldata(cd, modes[i]),
  );

  return { delegations, modes, executions };
}

function decodePermissionContext(context: Uint8Array): Delegation[] {
  const [rawChain] = decode(
    ['(address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)[]'],
    context,
  ) as [
    [Hex, Hex, Hex, [Hex, Hex, Hex][], bigint, Hex][],
  ];

  return rawChain.map(
    ([delegate, delegator, authority, caveats, salt, signature]) => ({
      delegate,
      delegator,
      authority,
      caveats: caveats.map(([enforcer, terms, args]) => ({
        enforcer,
        terms,
        args,
      })),
      salt: toHex(salt) as Hex,
      signature,
    }),
  );
}

function decodeExecutionCalldata(
  calldata: Uint8Array,
  mode: ExecutionMode,
): ExecutionStruct[] {
  if (mode === BATCH_DEFAULT_MODE || mode === BATCH_TRY_MODE) {
    const [items] = decode(['(address,uint256,bytes)[]'], calldata) as [
      [Hex, bigint, Hex][],
    ];
    return items.map(([target, value, callData]) => ({
      target,
      value,
      callData,
    }));
  }

  if (mode === SINGLE_DEFAULT_MODE || mode === SINGLE_TRY_MODE) {
    return [decodePackedSingleExecution(calldata)];
  }

  throw new Error(`Unsupported execution mode: ${mode}`);
}

// Inverse of encodeSingleExecution (packed ABI: 20-byte address || 32-byte uint256 || raw callData).
function decodePackedSingleExecution(calldata: Uint8Array): ExecutionStruct {
  const ADDRESS_BYTES = 20;
  const UINT256_BYTES = 32;
  const HEADER_BYTES = ADDRESS_BYTES + UINT256_BYTES;

  if (calldata.length < HEADER_BYTES) {
    throw new Error('Invalid packed single execution calldata');
  }

  const target = bytesToHex(calldata.slice(0, ADDRESS_BYTES)) as Hex;
  const valueBytes = calldata.slice(ADDRESS_BYTES, HEADER_BYTES);
  const value = BigInt(bytesToHex(valueBytes));
  const callData =
    calldata.length === HEADER_BYTES
      ? ('0x' as Hex)
      : (bytesToHex(calldata.slice(HEADER_BYTES)) as Hex);

  return { target, value, callData };
}

async function signAndWrapDelegation({
  transaction,
  caveats,
  messenger,
  delegatee,
  delegationSignature,
}: {
  transaction: TransactionMeta;
  caveats: Caveat[];
  messenger: SignMessenger;
  delegatee?: Hex;
  delegationSignature?: Hex;
}): Promise<Delegation[][]> {
  const unsignedDelegation = buildUnsignedDelegation(
    transaction,
    caveats,
    delegatee,
  );

  log('Signing delegation', unsignedDelegation);

  const signature =
    delegationSignature ??
    ((await messenger.call('DelegationController:signDelegation', {
      chainId: transaction.chainId,
      delegation: unsignedDelegation,
    })) as Hex);

  log('Delegation signature', signature);

  return [[{ ...unsignedDelegation, signature }]];
}

async function buildAuthorizationList(
  transactionMeta: TransactionMeta,
  messenger: SignMessenger,
  authorization: AuthorizationRequest,
): Promise<AuthorizationList | undefined> {
  const upgradeContractAddress = await resolveUpgradeContractAddress(
    transactionMeta,
    authorization,
  );

  if (!upgradeContractAddress) {
    return undefined;
  }

  const { TransactionController } = Engine.context;
  const { chainId, networkClientId, txParams } = transactionMeta;
  const { from } = txParams;

  log('Upgrading account to EIP-7702', { from, upgradeContractAddress });

  const nonceLock = await TransactionController.getNonceLock(
    from,
    networkClientId,
  );

  const nonce = nonceLock.nextNonce;
  nonceLock.releaseLock();

  const authorizationSignature = (await messenger.call(
    'KeyringController:signEip7702Authorization',
    {
      chainId: parseInt(chainId, 16),
      contractAddress: upgradeContractAddress,
      from,
      nonce,
    },
  )) as Hex;

  const { r, s, yParity } = decodeAuthorizationSignature(
    authorizationSignature,
  );

  log('Authorization signature', {
    authorizationSignature,
    r,
    s,
    yParity,
    nonce,
  });

  return [
    {
      address: upgradeContractAddress,
      chainId,
      nonce: toHex(nonce),
      r,
      s,
      yParity,
    },
  ];
}

async function resolveUpgradeContractAddress(
  transactionMeta: TransactionMeta,
  authorization: AuthorizationRequest,
): Promise<Hex | undefined> {
  if (authorization.upgradeContractAddress) {
    return authorization.upgradeContractAddress;
  }

  const { TransactionController } = Engine.context;
  const { chainId, txParams } = transactionMeta;
  const { from } = txParams;

  const atomicBatchResult = await TransactionController.isAtomicBatchSupported({
    address: from as Hex,
    chainIds: [chainId],
  });

  const chainResult = atomicBatchResult.find(
    (r) => r.chainId.toLowerCase() === chainId.toLowerCase(),
  );

  if (!chainResult) {
    throw new Error('Chain does not support EIP-7702');
  }

  if (chainResult.isSupported) {
    log('Skipping authorization as already upgraded');
    return undefined;
  }

  if (!chainResult.upgradeContractAddress) {
    throw new Error('Upgrade contract address not found');
  }

  if (chainResult.delegationAddress) {
    log('Overwriting existing delegation', {
      current: chainResult.delegationAddress,
      new: chainResult.upgradeContractAddress,
    });
  }

  return chainResult.upgradeContractAddress;
}

function buildDefaultCaveats(
  environment: DeleGatorEnvironment,
  executions: ExecutionStruct[],
): Caveat[] {
  const caveatBuilder = createCaveatBuilder(environment);

  if (executions.length > 1) {
    const executionParams = executions.map((ex) => ({
      to: ex.target as string,
      value: toHex(ex.value),
      data: ex.callData as string | undefined,
    }));
    caveatBuilder.addCaveat(exactExecutionBatch, executionParams);
  } else if (executions.length === 1) {
    const ex = executions[0];
    caveatBuilder.addCaveat(
      exactExecution,
      ex.target as string,
      toHex(ex.value),
      ex.callData as string | undefined,
    );
  }

  caveatBuilder.addCaveat(limitedCalls, 1);

  return caveatBuilder.build();
}

function buildUnsignedDelegation(
  transactionMeta: TransactionMeta,
  caveats: Caveat[],
  delegatee?: Hex,
): UnsignedDelegation {
  log('Caveats', caveats);

  const delegation = createDelegation({
    from: transactionMeta.txParams.from as Hex,
    to: delegatee ?? ANY_BENEFICIARY,
    caveats,
  });

  log('Delegation', delegation);

  return delegation;
}

export function normalizeCallData(data: unknown): Hex {
  if (typeof data !== 'string' || data.length === 0) {
    return '0x';
  }

  const hasHexPrefix = data.slice(0, 2).toLowerCase() === '0x';
  const lower = data.toLowerCase();
  const prefixed = hasHexPrefix ? `0x${lower.slice(2)}` : `0x${lower}`;
  const hexBody = prefixed.slice(2);

  if (hexBody.length === 0) {
    return '0x';
  }

  if (hexBody.length % 2 !== 0) {
    return normalizeCallData(`0x0${hexBody}`);
  }

  return prefixed as Hex;
}

function toHexBytes(value: Uint8Array | string): Hex {
  if (typeof value === 'string') {
    return add0x(value) as Hex;
  }
  return bytesToHex(value);
}
