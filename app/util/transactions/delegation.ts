import { decode } from '@metamask/abi-utils';
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

export interface DelegationTransaction {
  authorizationList?: AuthorizationList;
  data: Hex;
  to: Hex;
  value: Hex;
}

interface FlattenedRedemption {
  contexts: Hex[];
  modes: Hex[];
  calldatas: Hex[];
}

export async function getDelegationTransaction<
  MessengerType extends SignMessenger,
>(
  messenger: MessengerType,
  transaction: TransactionMeta,
): Promise<DelegationTransaction> {
  const { chainId } = transaction;
  const delegationEnvironment = getDeleGatorEnvironment(parseInt(chainId, 16));

  const delegationManagerAddress =
    delegationEnvironment.DelegationManager as Hex;

  const { regularTransactions, flattened } = partitionNestedTransactions(
    transaction.nestedTransactions ?? [],
    delegationManagerAddress,
  );

  if (flattened.contexts.length > 0) {
    log('Flattening nested redeemDelegations slots', {
      flattenedCount: flattened.contexts.length,
      regularCount: regularTransactions.length,
    });
  }

  // Outer delegation authorises only the non-redeem slots; flattened slots carry their own permission contexts.
  const outerTransaction: TransactionMeta = {
    ...transaction,
    nestedTransactions: regularTransactions,
  };

  const outerDelegations = regularTransactions.length
    ? await buildDelegation(delegationEnvironment, outerTransaction, messenger)
    : [];

  const outerExecutions = regularTransactions.length
    ? buildExecutions(outerTransaction)
    : [];

  const outerModes: ExecutionMode[] = regularTransactions.length
    ? [regularTransactions.length > 1 ? BATCH_DEFAULT_MODE : SINGLE_DEFAULT_MODE]
    : [];

  log('Built delegations', {
    delegations: outerDelegations,
    modes: outerModes,
    executions: outerExecutions,
  });

  const transactionData = encodeRedeemDelegations({
    delegations: outerDelegations,
    modes: outerModes,
    executions: outerExecutions,
    extraContexts: flattened.contexts,
    extraModes: flattened.modes,
    extraCalldatas: flattened.calldatas,
  });

  const authorizationList = await buildAuthorizationList(
    transaction,
    messenger,
  );

  return {
    authorizationList,
    data: transactionData,
    to: delegationManagerAddress,
    value: '0x0',
  };
}

/**
 * Splits the nested transactions into transactions that the outer delegation
 * must authorise and pre-encoded redeemDelegations slots that can be merged
 * into the outer redeemDelegations call directly. This avoids the cost of
 * wrapping an already-authorised redeemDelegations inside another delegation.
 *
 * @param nestedTransactions - The transaction's nestedTransactions array.
 * @param delegationManagerAddress - The DelegationManager address for the
 * current chain. Used to identify nested redeemDelegations calls.
 */
function partitionNestedTransactions(
  nestedTransactions: NestedTransactionMetadata[],
  delegationManagerAddress: Hex,
): {
  regularTransactions: NestedTransactionMetadata[];
  flattened: FlattenedRedemption;
} {
  const regularTransactions: NestedTransactionMetadata[] = [];
  const flattened: FlattenedRedemption = {
    contexts: [],
    modes: [],
    calldatas: [],
  };

  for (const tx of nestedTransactions) {
    const decoded = decodeRedeemDelegationsCall(tx, delegationManagerAddress);

    if (!decoded) {
      regularTransactions.push(tx);
      continue;
    }

    flattened.contexts.push(...decoded.contexts);
    flattened.modes.push(...decoded.modes);
    flattened.calldatas.push(...decoded.calldatas);
  }

  return { regularTransactions, flattened };
}

/**
 * Returns the decoded (contexts, modes, calldatas) tuple if the nested
 * transaction is a redeemDelegations call to the DelegationManager on the
 * current chain. Returns undefined otherwise.
 */
function decodeRedeemDelegationsCall(
  tx: NestedTransactionMetadata,
  delegationManagerAddress: Hex,
): FlattenedRedemption | undefined {
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
      contexts: rawContexts.map(toHexBytes),
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

function toHexBytes(value: Uint8Array | string): Hex {
  if (typeof value === 'string') {
    return add0x(value) as Hex;
  }
  return bytesToHex(value);
}

async function buildAuthorizationList<MessengerType extends SignMessenger>(
  transactionMeta: TransactionMeta,
  messenger: MessengerType,
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

async function buildDelegation<MessengerType extends SignMessenger>(
  delegationEnvironment: DeleGatorEnvironment,
  transactionMeta: TransactionMeta,
  messenger: MessengerType,
): Promise<Delegation[][]> {
  const unsignedDelegation = buildUnsignedDelegation(
    delegationEnvironment,
    transactionMeta,
  );

  log('Signing delegation');

  const delegationSignature = (await messenger.call(
    'DelegationController:signDelegation',
    {
      chainId: transactionMeta.chainId,
      delegation: unsignedDelegation,
    },
  )) as Hex;

  log('Delegation signature', delegationSignature);

  const delegations: Delegation[][] = [
    [
      {
        ...unsignedDelegation,

        signature: delegationSignature,
      },
    ],
  ];

  return delegations;
}

function buildExecutions(
  transactionMeta: TransactionMeta,
): ExecutionStruct[][] {
  const { nestedTransactions } = transactionMeta;

  return [
    (nestedTransactions ?? []).map((tx) => ({
      target: tx.to as Hex,
      value: BigInt(tx.value ?? '0x0'),
      callData: tx.data as Hex,
    })),
  ];
}

function buildUnsignedDelegation(
  environment: DeleGatorEnvironment,
  transactionMeta: TransactionMeta,
): UnsignedDelegation {
  const caveats = buildCaveats(environment, transactionMeta);

  log('Caveats', caveats);

  const delegation = createDelegation({
    from: transactionMeta.txParams.from as Hex,
    to: ANY_BENEFICIARY,
    caveats,
  });

  log('Delegation', delegation);

  return delegation;
}

function buildCaveats(
  environment: DeleGatorEnvironment,
  transaction: TransactionMeta,
): Caveat[] {
  const caveatBuilder = createCaveatBuilder(environment);
  const { nestedTransactions } = transaction;

  const executions = (transaction.nestedTransactions ?? []).map((tx) => ({
    to: tx.to as string,
    value: tx.value ?? '0x0',
    data: tx.data as string | undefined,
  }));

  if ((nestedTransactions ?? []).length > 1) {
    caveatBuilder.addCaveat(exactExecutionBatch, executions);
  } else {
    caveatBuilder.addCaveat(
      exactExecution,
      executions[0].to,
      executions[0].value,
      executions[0].data,
    );
  }

  caveatBuilder.addCaveat(limitedCalls, 1);

  return caveatBuilder.build();
}
