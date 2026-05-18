import { decode, encode } from '@metamask/abi-utils';
import {
  IsAtomicBatchSupportedRequest,
  TransactionController,
  TransactionMeta,
} from '@metamask/transaction-controller';
import {
  SignMessenger,
  convertTransactionToRedeemDelegations,
} from './delegation';
import { MOCK_ANY_NAMESPACE, Messenger } from '@metamask/messenger';
import { Hex, bytesToHex, remove0x } from '@metamask/utils';
import {
  BATCH_DEFAULT_MODE,
  SINGLE_DEFAULT_MODE,
  getDeleGatorEnvironment,
} from '../../core/Delegation';
import { REDEEM_DELEGATIONS_SELECTOR } from '../../core/Delegation/delegation';
import {
  concat,
  toFunctionSelector,
  toHex,
} from '../../core/Delegation/utils';

const mockGetNonceLock = jest.fn();

const mockIsAtomicBatchSupported: jest.MockedFn<
  TransactionController['isAtomicBatchSupported']
> = jest.fn();

jest.spyOn(Math, 'random').mockReturnValue(0);

jest.mock('../../core/Engine', () => ({
  context: {
    TransactionController: {
      getNonceLock: () => mockGetNonceLock(),
      isAtomicBatchSupported: (request: IsAtomicBatchSupportedRequest) =>
        mockIsAtomicBatchSupported(request),
    },
  },
}));

const DELEGATION_SIGNATURE_MOCK = '0x111222333';
const UPGRADE_CONTRACT_ADDRESS_MOCK = '0x456' as Hex;
const NONCE_MOCK = 123;

const AUTHORIZATION_SIGNATURE_MOCK =
  '0xf85c827a6994663f3ad617193148711d28f5334ee4ed070166028080a040e292da533253143f134643a03405f1af1de1d305526f44ed27e62061368d4ea051cfb0af34e491aa4d6796dececf95569088322e116c4b2f312bb23f20699269';

const TRANSACTION_META_MOCK = {
  chainId: '0x1' as Hex,
  nestedTransactions: [
    {
      data: '0x123456781234' as Hex,
      to: '0x1234567890abcdef1234567890abcdef12345678' as Hex,
    },
  ],
  txParams: {
    from: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  },
} as TransactionMeta;

describe('Transaction Delegation Utils', () => {
  const signDelegationMock = jest.fn();
  const sign7702Mock = jest.fn();
  let messengerMock: SignMessenger;

  beforeEach(() => {
    jest.clearAllMocks();

    messengerMock = new Messenger({
      namespace: MOCK_ANY_NAMESPACE,
    });

    messengerMock.registerActionHandler(
      'DelegationController:signDelegation',
      signDelegationMock,
    );

    messengerMock.registerActionHandler(
      'KeyringController:signEip7702Authorization',
      sign7702Mock,
    );

    signDelegationMock.mockResolvedValue(DELEGATION_SIGNATURE_MOCK);
    sign7702Mock.mockResolvedValue(AUTHORIZATION_SIGNATURE_MOCK);

    mockIsAtomicBatchSupported.mockResolvedValue([
      {
        chainId: TRANSACTION_META_MOCK.chainId,
        isSupported: false,
        upgradeContractAddress: UPGRADE_CONTRACT_ADDRESS_MOCK,
      },
    ]);

    mockGetNonceLock.mockResolvedValue({
      nextNonce: NONCE_MOCK,
      releaseLock: jest.fn(),
    });
  });

  describe('convertTransactionToRedeemDelegations', () => {
    it('returns delegation data with authorization list when not upgraded', async () => {
      const result = await convertTransactionToRedeemDelegations({
        transaction: TRANSACTION_META_MOCK,
        messenger: messengerMock,
        authorization: {},
      });

      expect(result).toBeDefined();
      expect(result.to).toBeDefined();
      expect(result.data).toBeDefined();
      expect(result.authorizationList).toHaveLength(1);
      expect(result.authorizationList?.[0].address).toBe(
        UPGRADE_CONTRACT_ADDRESS_MOCK,
      );
    });

    it('does not include authorization if already upgraded', async () => {
      mockIsAtomicBatchSupported.mockResolvedValue([
        {
          chainId: TRANSACTION_META_MOCK.chainId,
          delegationAddress: UPGRADE_CONTRACT_ADDRESS_MOCK,
          isSupported: true,
          upgradeContractAddress: UPGRADE_CONTRACT_ADDRESS_MOCK,
        },
      ]);

      const result = await convertTransactionToRedeemDelegations({
        transaction: {
          ...TRANSACTION_META_MOCK,
          delegationAddress: UPGRADE_CONTRACT_ADDRESS_MOCK,
        } as TransactionMeta,
        messenger: messengerMock,
        authorization: {},
      });

      expect(result.authorizationList).toBeUndefined();
    });

    it('includes authorization if upgraded to different contract', async () => {
      mockIsAtomicBatchSupported.mockResolvedValue([
        {
          chainId: TRANSACTION_META_MOCK.chainId,
          delegationAddress: UPGRADE_CONTRACT_ADDRESS_MOCK,
          isSupported: false,
          upgradeContractAddress: '0x789' as Hex,
        },
      ]);

      const result = await convertTransactionToRedeemDelegations({
        transaction: {
          ...TRANSACTION_META_MOCK,
          delegationAddress: UPGRADE_CONTRACT_ADDRESS_MOCK,
        } as TransactionMeta,
        messenger: messengerMock,
        authorization: {},
      });

      expect(result.authorizationList).toHaveLength(1);
    });

    it('uses provided upgradeContractAddress without querying isAtomicBatchSupported', async () => {
      const providedAddress = '0xabc' as Hex;

      const result = await convertTransactionToRedeemDelegations({
        transaction: TRANSACTION_META_MOCK,
        messenger: messengerMock,
        authorization: { upgradeContractAddress: providedAddress },
      });

      expect(result.authorizationList?.[0].address).toBe(providedAddress);
      expect(mockIsAtomicBatchSupported).not.toHaveBeenCalled();
    });

    it('calls DelegationController to sign delegation', async () => {
      await convertTransactionToRedeemDelegations({
        transaction: TRANSACTION_META_MOCK,
        messenger: messengerMock,
      });

      expect(signDelegationMock).toHaveBeenCalledWith({
        chainId: TRANSACTION_META_MOCK.chainId,
        delegation: expect.any(Object),
      });
    });

    it('calls KeyringController to sign authorization', async () => {
      await convertTransactionToRedeemDelegations({
        transaction: TRANSACTION_META_MOCK,
        messenger: messengerMock,
        authorization: {},
      });

      expect(sign7702Mock).toHaveBeenCalledWith({
        chainId: 1,
        contractAddress: UPGRADE_CONTRACT_ADDRESS_MOCK,
        from: TRANSACTION_META_MOCK.txParams.from,
        nonce: NONCE_MOCK,
      });
    });

    it('throws if chain does not support EIP-7702', async () => {
      mockIsAtomicBatchSupported.mockResolvedValue([]);

      await expect(
        convertTransactionToRedeemDelegations({
          transaction: TRANSACTION_META_MOCK,
          messenger: messengerMock,
          authorization: {},
        }),
      ).rejects.toThrow('Chain does not support EIP-7702');
    });

    it('throws if upgrade contract address is not found', async () => {
      mockIsAtomicBatchSupported.mockResolvedValue([
        {
          chainId: TRANSACTION_META_MOCK.chainId,
          isSupported: false,
          upgradeContractAddress: undefined,
        },
      ]);

      await expect(
        convertTransactionToRedeemDelegations({
          transaction: TRANSACTION_META_MOCK,
          messenger: messengerMock,
          authorization: {},
        }),
      ).rejects.toThrow('Upgrade contract address not found');
    });

    it('does not include authorization list by default', async () => {
      const result = await convertTransactionToRedeemDelegations({
        transaction: TRANSACTION_META_MOCK,
        messenger: messengerMock,
      });

      expect(result.authorizationList).toBeUndefined();
    });

    it('uses provided caveats instead of deriving them', async () => {
      const customCaveat = {
        enforcer: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hex,
        terms: '0x' as Hex,
        args: '0x' as Hex,
      };

      await convertTransactionToRedeemDelegations({
        transaction: TRANSACTION_META_MOCK,
        messenger: messengerMock,
        caveats: [customCaveat],
      });

      expect(signDelegationMock).toHaveBeenCalledWith({
        chainId: TRANSACTION_META_MOCK.chainId,
        delegation: expect.objectContaining({
          caveats: [customCaveat],
        }),
      });
    });

    it('appends additionalExecutions to the execution batch', async () => {
      const extraAddress = '0x1111111111111111111111111111111111111111' as Hex;
      const extra = {
        target: extraAddress,
        value: BigInt(0),
        callData: '0x' as Hex,
      };

      await convertTransactionToRedeemDelegations({
        transaction: TRANSACTION_META_MOCK,
        messenger: messengerMock,
        additionalExecutions: [extra],
      });

      const [signCall] = signDelegationMock.mock.calls;
      const signedDelegation = signCall[0].delegation;
      expect(signedDelegation.caveats.length).toBeGreaterThan(0);
    });

    it('uses provided delegationSignature instead of calling messenger', async () => {
      const precomputedSig = '0xdeadbeef' as Hex;

      await convertTransactionToRedeemDelegations({
        transaction: TRANSACTION_META_MOCK,
        messenger: messengerMock,
        delegationSignature: precomputedSig,
      });

      expect(signDelegationMock).not.toHaveBeenCalled();
    });

    it('falls back to txParams when nestedTransactions is empty', async () => {
      const txTo = '0x4444444444444444444444444444444444444444' as Hex;
      const txData = '0xfeedface' as Hex;

      await convertTransactionToRedeemDelegations({
        transaction: {
          ...TRANSACTION_META_MOCK,
          nestedTransactions: undefined,
          txParams: {
            ...TRANSACTION_META_MOCK.txParams,
            to: txTo,
            value: '0x0' as Hex,
            data: txData,
          },
        } as TransactionMeta,
        messenger: messengerMock,
      });

      expect(signDelegationMock).toHaveBeenCalledTimes(1);
    });

    describe('nested redeemDelegations flattening', () => {
      const MAINNET_DELEGATION_MANAGER = getDeleGatorEnvironment(
        1,
      ).DelegationManager.toLowerCase() as Hex;

      const INNER_CONTEXT = '0xaabb' as Hex;
      const INNER_CALLDATA = '0xccdd' as Hex;

      const buildInnerRedeemCalldata = (): Hex => {
        const selector = toFunctionSelector(
          'redeemDelegations(bytes[],bytes32[],bytes[])',
        );
        const payload = toHex(
          encode(
            ['bytes[]', 'bytes32[]', 'bytes[]'],
            [[INNER_CONTEXT], [SINGLE_DEFAULT_MODE], [INNER_CALLDATA]],
          ),
        );
        return concat([selector, payload]);
      };

      const decodeOuter = (
        outerData: Hex,
      ): { contexts: Hex[]; modes: Hex[]; calldatas: Hex[] } => {
        const payload = `0x${remove0x(outerData).slice(8)}` as Hex;
        const [contexts, modes, calldatas] = decode(
          ['bytes[]', 'bytes32[]', 'bytes[]'],
          payload,
        ) as [Uint8Array[], Uint8Array[], Uint8Array[]];
        return {
          contexts: contexts.map(bytesToHex),
          modes: modes.map(bytesToHex),
          calldatas: calldatas.map(bytesToHex),
        };
      };

      it('flattens an inner redeemDelegations into additional outer slots', async () => {
        const innerRedeem = buildInnerRedeemCalldata();
        const regularTx = {
          data: '0xdeadbeef' as Hex,
          to: '0x1111111111111111111111111111111111111111' as Hex,
        };

        const result = await convertTransactionToRedeemDelegations({
          transaction: {
            ...TRANSACTION_META_MOCK,
            nestedTransactions: [
              {
                data: innerRedeem,
                to: MAINNET_DELEGATION_MANAGER,
              },
              regularTx,
            ],
          } as TransactionMeta,
          messenger: messengerMock,
        });

        const outer = decodeOuter(result.data);

        expect(outer.contexts).toHaveLength(2);
        expect(outer.modes).toHaveLength(2);
        expect(outer.calldatas).toHaveLength(2);
        expect(outer.contexts[1]).toBe(INNER_CONTEXT);
        expect(outer.modes[1]).toBe(SINGLE_DEFAULT_MODE);
        expect(outer.calldatas[1]).toBe(INNER_CALLDATA);
      });

      it('signs the outer delegation only over the non-redeem nested transactions', async () => {
        const innerRedeem = buildInnerRedeemCalldata();
        const regularTx = {
          data: '0xdeadbeef' as Hex,
          to: '0x1111111111111111111111111111111111111111' as Hex,
        };

        await convertTransactionToRedeemDelegations({
          transaction: {
            ...TRANSACTION_META_MOCK,
            nestedTransactions: [
              { data: innerRedeem, to: MAINNET_DELEGATION_MANAGER },
              regularTx,
            ],
          } as TransactionMeta,
          messenger: messengerMock,
        });

        expect(signDelegationMock).toHaveBeenCalledTimes(1);
        const [signCall] = signDelegationMock.mock.calls;
        const signedDelegation = signCall[0].delegation;
        expect(signedDelegation.caveats).toHaveLength(2);
      });

      it('uses SINGLE mode when only one regular nested transaction remains after flattening', async () => {
        const innerRedeem = buildInnerRedeemCalldata();
        const regularTx = {
          data: '0xdeadbeef' as Hex,
          to: '0x1111111111111111111111111111111111111111' as Hex,
        };

        const result = await convertTransactionToRedeemDelegations({
          transaction: {
            ...TRANSACTION_META_MOCK,
            nestedTransactions: [
              { data: innerRedeem, to: MAINNET_DELEGATION_MANAGER },
              regularTx,
            ],
          } as TransactionMeta,
          messenger: messengerMock,
        });

        const outer = decodeOuter(result.data);
        expect(outer.modes[0]).toBe(SINGLE_DEFAULT_MODE);
      });

      it('does not flatten nested redeemDelegations when target is not the DelegationManager', async () => {
        const innerRedeem = buildInnerRedeemCalldata();
        const result = await convertTransactionToRedeemDelegations({
          transaction: {
            ...TRANSACTION_META_MOCK,
            nestedTransactions: [
              {
                data: innerRedeem,
                to: '0x2222222222222222222222222222222222222222' as Hex,
              },
            ],
          } as TransactionMeta,
          messenger: messengerMock,
        });

        const outer = decodeOuter(result.data);
        expect(outer.contexts).toHaveLength(1);
        expect(signDelegationMock).toHaveBeenCalledTimes(1);
      });

      it('does not flatten when nested tx data does not start with the redeemDelegations selector', async () => {
        const result = await convertTransactionToRedeemDelegations({
          transaction: {
            ...TRANSACTION_META_MOCK,
            nestedTransactions: [
              {
                data: '0xdeadbeef' as Hex,
                to: MAINNET_DELEGATION_MANAGER,
              },
            ],
          } as TransactionMeta,
          messenger: messengerMock,
        });

        const outer = decodeOuter(result.data);
        expect(outer.contexts).toHaveLength(1);
      });

      it('passes through inner contexts unchanged when only inner redeemDelegations are present', async () => {
        const innerRedeem = buildInnerRedeemCalldata();
        const result = await convertTransactionToRedeemDelegations({
          transaction: {
            ...TRANSACTION_META_MOCK,
            nestedTransactions: [
              { data: innerRedeem, to: MAINNET_DELEGATION_MANAGER },
            ],
          } as TransactionMeta,
          messenger: messengerMock,
        });

        const outer = decodeOuter(result.data);
        expect(outer.contexts).toEqual([INNER_CONTEXT]);
        expect(outer.modes).toEqual([SINGLE_DEFAULT_MODE]);
        expect(outer.calldatas).toEqual([INNER_CALLDATA]);
        expect(signDelegationMock).not.toHaveBeenCalled();
      });

      it('selects the correct selector for a redeemDelegations nested tx', () => {
        expect(REDEEM_DELEGATIONS_SELECTOR).toBe('0xcef6d209');
      });

      it('uses BATCH mode when multiple regular nested transactions remain after flattening', async () => {
        const innerRedeem = buildInnerRedeemCalldata();
        const result = await convertTransactionToRedeemDelegations({
          transaction: {
            ...TRANSACTION_META_MOCK,
            nestedTransactions: [
              { data: innerRedeem, to: MAINNET_DELEGATION_MANAGER },
              {
                data: '0xdeadbeef' as Hex,
                to: '0x1111111111111111111111111111111111111111' as Hex,
              },
              {
                data: '0xfeedface' as Hex,
                to: '0x3333333333333333333333333333333333333333' as Hex,
              },
            ],
          } as TransactionMeta,
          messenger: messengerMock,
        });

        const outer = decodeOuter(result.data);
        expect(outer.modes[0]).toBe(BATCH_DEFAULT_MODE);
        expect(outer.contexts).toHaveLength(2);
      });
    });
  });
});
