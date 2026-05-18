import { decode , encode } from '@metamask/abi-utils';
import {
  AuthorizationList,
  NestedTransactionMetadata,
  TransactionMeta,
  decodeAuthorizationSignature,
} from '@metamask/transaction-controller';
import {
  BATCH_DEFAULT_MODE,
  Caveat,
  DeleGatorEnvironment,
  ExecutionMode,
  ExecutionStruct,
  SINGLE_DEFAULT_MODE,
  createCaveatBuilder,
  getDeleGatorEnvironment,
} from '../../core/Delegation';
import {
  ANY_BENEFICIARY,
  Delegation,
  REDEEM_DELEGATIONS_SELECTOR,
  UnsignedDelegation,
  createDelegation,
  encodePermissionContexts,
} from '../../core/Delegation/delegation';
import { encodeExecutionCalldatas } from '../../core/Delegation/execution';
import { Hex, add0x, bytesToHex, createProjectLogger, remove0x } from '@metamask/utils';
import { limitedCalls } from '../../core/Delegation/caveatBuilder/limitedCallsBuilder';
import { Messenger } from '@metamask/messenger';
import { DelegationControllerSignDelegationAction } from '@metamask/delegation-controller';
import { KeyringControllerSignEip7702AuthorizationAction } from '@metamask/keyring-controller';
import { toHex } from '@metamask/controller-utils';
import {
  concat as concatHex,
  toFunctionSelector,
  toHex as bytesToHexString,
} from '../../core/Delegation/utils';
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

export interface ConvertTransactionToRedeemDelegationsRequest {
  transaction: TransactionMeta;
  messenger: SignMessenger;
  caveats?: Caveat[];
  additionalExecutions?: ExecutionStruct[];
  delegatee?: Hex;
  delegationSignature?: Hex;
  skipAuthorization?: boolean;
}

export interface ConvertTransactionToRedeemDelegationsResult {
  authorizationList?: AuthorizationList;
  data: Hex;
  to: Hex;
}

interface InnerRedemption {
  permissionContexts: Hex[];
  modes: Hex[];
  calldatas: Hex[];
}

export async function convertTransactionToRedeemDelegations(
  request: ConvertTransactionToRedeemDelegationsRequest,
): Promise<ConvertTransactionToRedeemDelegationsResult> {
  const { transaction, messenger } = request;
  const { chainId } = transaction;
  const delegationEnvironment = getDeleGatorEnvironment(parseInt(chainId, 16));
  const delegationManagerAddress = delegationEnvironment.DelegationManager as Hex;

  const { regularTransactions, inner } = partitionNestedTransactions(
    transaction.nestedTransactions ?? [],
    delegationManagerAddress,
  );

  if (inner.permissionContexts.length > 0) {
    log('Flattening inner redeemDelegations slots', {
      innerCount: inner.permissionContexts.length,
      regularCount: regularTransactions.length,
    });
  }

  const hadOriginalNested = Boolean(transaction.nestedTransactions?.length);
  const allInner =
    hadOriginalNested && regularTransactions.length === 0;

  const outerTransaction: TransactionMeta = {
    ...transaction,
    nestedTransactions: regularTransactions,
  };

  const defaultExecutions = allInner ? [] : buildDefaultExecutions(outerTransaction);
  const additionalExecutions = request.additionalExecutions ?? [];
  const allExecutions: ExecutionStruct[] = [...defaultExecutions, ...additionalExecutions];

  const hasOuterSlots = allExecutions.length > 0;

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

  const permissionContexts = [
    ...(hasOuterSlots ? encodePermissionContexts(outerDelegations) : []),
    ...inner.permissionContexts,
  ];
  const modes = [...(outerMode ? [outerMode] : []), ...inner.modes];
  const calldatas = [
    ...(hasOuterSlots ? encodeExecutionCalldatas([allExecutions]) : []),
    ...inner.calldatas,
  ];

  log('Built redeemDelegations call', {
    permissionContexts,
    modes,
    calldatas,
  });

  const data = encodeRedeemDelegationsCall({
    permissionContexts,
    modes,
    calldatas,
  });

  const authorizationList = request.skipAuthorization
    ? undefined
    : await buildAuthorizationList(transaction, messenger);

  return {
    authorizationList,
    data,
    to: delegationManagerAddress,
  };
}

function encodeRedeemDelegationsCall({
  permissionContexts,
  modes,
  calldatas,
}: {
  permissionContexts: Hex[];
  modes: Hex[];
  calldatas: Hex[];
}): Hex {
  const selector = toFunctionSelector(
    'redeemDelegations(bytes[],bytes32[],bytes[])',
  );
  const payload = bytesToHexString(
    encode(
      ['bytes[]', 'bytes32[]', 'bytes[]'],
      [permissionContexts, modes, calldatas],
    ),
  );
  return concatHex([selector, payload]);
}

function partitionNestedTransactions(
  nestedTransactions: NestedTransactionMetadata[],
  delegationManagerAddress: Hex,
): {
  regularTransactions: NestedTransactionMetadata[];
  inner: InnerRedemption;
} {
  const regularTransactions: NestedTransactionMetadata[] = [];
  const inner: InnerRedemption = {
    permissionContexts: [],
    modes: [],
    calldatas: [],
  };

  for (const tx of nestedTransactions) {
    const decoded = decodeRedeemDelegationsCall(tx, delegationManagerAddress);

    if (!decoded) {
      regularTransactions.push(tx);
      continue;
    }

    inner.permissionContexts.push(...decoded.permissionContexts);
    inner.modes.push(...decoded.modes);
    inner.calldatas.push(...decoded.calldatas);
  }

  return { regularTransactions, inner };
}

function decodeRedeemDelegationsCall(
  tx: NestedTransactionMetadata,
  delegationManagerAddress: Hex,
): InnerRedemption | undefined {
  const { data, to } = tx;

  if (!data || !to) {
    return undefined;
  }

  if (to.toLowerCase() !== delegationManagerAddress.toLowerCase()) {
    return undefined;
  }

  if (!data.toLowerCase().startsWith(REDEEM_DELEGATIONS_SELECTOR)) {
    return undefined;
  }

  const SELECTOR_HEX_CHARS = 8;
  const payload = `0x${remove0x(data).slice(SELECTOR_HEX_CHARS)}` as Hex;

  try {
    const [rawContexts, rawModes, rawCalldatas] = decode(
      ['bytes[]', 'bytes32[]', 'bytes[]'],
      payload,
    ) as [Uint8Array[], Uint8Array[], Uint8Array[]];

    return {
      permissionContexts: rawContexts.map(toHexBytes),
      modes: rawModes.map(toHexBytes),
      calldatas: rawCalldatas.map(toHexBytes),
    };
  } catch (error) {
    log('Failed to decode nested redeemDelegations, falling back to nesting', {
      error,
    });
    return undefined;
  }
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
): Promise<AuthorizationList | undefined> {
  const { TransactionController } = Engine.context;
  const { chainId, networkClientId, txParams } = transactionMeta;
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

  const { delegationAddress, isSupported, upgradeContractAddress } =
    chainResult;

  if (isSupported) {
    log('Skipping authorization as already upgraded');
    return undefined;
  }

  if (!delegationAddress) {
    log('Upgrading account to EIP-7702', { from, upgradeContractAddress });
  } else {
    log('Overwriting authorization as already upgraded', {
      from,
      current: delegationAddress,
      new: upgradeContractAddress,
    });
  }

  if (!upgradeContractAddress) {
    throw new Error('Upgrade contract address not found');
  }

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

function buildDefaultExecutions(
  transactionMeta: TransactionMeta,
): ExecutionStruct[] {
  const { nestedTransactions, txParams } = transactionMeta;

  if (nestedTransactions?.length && nestedTransactions[0].to) {
    return nestedTransactions.map((tx) => ({
      target: tx.to as Hex,
      value: BigInt(tx.value ?? '0x0'),
      callData: normalizeCallData(tx.data),
    }));
  }

  return [
    {
      target: txParams.to as Hex,
      value: BigInt((txParams.value as Hex) ?? '0x0'),
      callData: normalizeCallData(txParams.data),
    },
  ];
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
  } else {
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
