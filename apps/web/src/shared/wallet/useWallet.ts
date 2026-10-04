import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserProvider, Contract, formatUnits, parseUnits } from 'ethers';
import {
  PRIMARY_CHAIN,
  USDG,
  MARKET_MERCHANT,
  robinhoodChainParams,
} from '../chains';

/* Real wallet connection only: window.ethereum via ethers v6. No fakes,
 * no injected demo accounts. Every failure surfaces honestly. */

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
];

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown }) => Promise<unknown>;
      on?: (event: string, cb: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
    };
  }
}

export type WalletStatus =
  | 'no-provider'
  | 'disconnected'
  | 'connecting'
  | 'wrong-chain'
  | 'connected';

export interface UseWallet {
  status: WalletStatus;
  address: string | null;
  usdgBalance: string | null;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** Pay an exact USDG amount to the market merchant. Resolves with the tx hash. */
  payUsdg: (amountUsdg: string) => Promise<string>;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function useWallet(): UseWallet {
  const [status, setStatus] = useState<WalletStatus>(
    typeof window !== 'undefined' && window.ethereum ? 'disconnected' : 'no-provider',
  );
  const [address, setAddress] = useState<string | null>(null);
  const [usdgBalance, setUsdgBalance] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providerRef = useRef<BrowserProvider | null>(null);

  const refreshBalance = useCallback(async (addr: string) => {
    try {
      const p = providerRef.current ?? new BrowserProvider(window.ethereum!);
      providerRef.current = p;
      const token = new Contract(USDG.address, ERC20_ABI, p);
      const bal: bigint = await token.balanceOf(addr);
      setUsdgBalance(formatUnits(bal, USDG.decimals));
    } catch {
      setUsdgBalance(null);
    }
  }, []);

  const syncFromProvider = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) {
      setStatus('no-provider');
      return;
    }
    try {
      const accounts = (await eth.request({ method: 'eth_accounts' })) as string[];
      const chainHex = (await eth.request({ method: 'eth_chainId' })) as string;
      const chainId = parseInt(chainHex, 16);
      if (accounts.length === 0) {
        setStatus('disconnected');
        setAddress(null);
        setUsdgBalance(null);
        return;
      }
      setAddress(accounts[0]);
      if (chainId !== PRIMARY_CHAIN.chainId) {
        setStatus('wrong-chain');
        setUsdgBalance(null);
        return;
      }
      setStatus('connected');
      setError(null);
      void refreshBalance(accounts[0]);
    } catch {
      setStatus('disconnected');
    }
  }, [refreshBalance]);

  useEffect(() => {
    void syncFromProvider();
    const eth = window.ethereum;
    if (!eth?.on) return;
    const onAccounts = (accs: unknown) => {
      const list = accs as string[];
      if (!list || list.length === 0) {
        setStatus('disconnected');
        setAddress(null);
        setUsdgBalance(null);
      } else {
        setAddress(list[0]);
        void syncFromProvider();
      }
    };
    const onChain = () => {
      void syncFromProvider();
    };
    eth.on('accountsChanged', onAccounts);
    eth.on('chainChanged', onChain);
    return () => {
      eth.removeListener?.('accountsChanged', onAccounts);
      eth.removeListener?.('chainChanged', onChain);
    };
  }, [syncFromProvider]);

  const ensureChain = useCallback(async (): Promise<boolean> => {
    const eth = window.ethereum!;
    const want = `0x${PRIMARY_CHAIN.chainId.toString(16)}`;
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
      return true;
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 4902) {
        try {
          await eth.request({ method: 'wallet_addEthereumChain', params: [robinhoodChainParams()] });
          return true;
        } catch (addErr) {
          if ((addErr as { code?: number }).code === 4001) {
            setError('Chain add rejected in wallet.');
          } else {
            setError('Could not add Robinhood Chain to your wallet.');
          }
          return false;
        }
      }
      if (code === 4001) {
        setError('Network switch rejected in wallet.');
      } else {
        setError('Could not switch to Robinhood Chain.');
      }
      return false;
    }
  }, []);

  const connect = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) {
      setStatus('no-provider');
      setError('No wallet detected. Install a browser wallet (e.g. MetaMask, Rabby, Coinbase Wallet) to continue.');
      return;
    }
    setError(null);
    setStatus('connecting');
    try {
      const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
      if (!accounts || accounts.length === 0) {
        setStatus('disconnected');
        return;
      }
      setAddress(accounts[0]);
      const ok = await ensureChain();
      if (!ok) {
        setStatus('wrong-chain');
        return;
      }
      setStatus('connected');
      void refreshBalance(accounts[0]);
    } catch (err) {
      if ((err as { code?: number }).code === 4001) {
        setError('Connection rejected in wallet.');
      } else {
        setError('Could not connect to wallet.');
      }
      setStatus('disconnected');
    }
  }, [ensureChain, refreshBalance]);

  const disconnect = useCallback(() => {
    // EIP-1193 has no disconnect; this clears the site's session only.
    providerRef.current = null;
    setAddress(null);
    setUsdgBalance(null);
    setError(null);
    setStatus(window.ethereum ? 'disconnected' : 'no-provider');
  }, []);

  const payUsdg = useCallback(
    async (amountUsdg: string): Promise<string> => {
      const eth = window.ethereum;
      if (!eth || !address) throw new Error('Wallet not connected.');
      const onChain = await ensureChain();
      if (!onChain) throw new Error('Robinhood Chain (4663) is required to pay.');
      const provider = new BrowserProvider(eth);
      providerRef.current = provider;
      const signer = await provider.getSigner();
      const token = new Contract(USDG.address, ERC20_ABI, signer);
      const value = parseUnits(amountUsdg, USDG.decimals);
      const bal: bigint = await token.balanceOf(address);
      if (bal < value) {
        throw new Error(
          `Insufficient USDG balance (${formatUnits(bal, USDG.decimals)} ${USDG.symbol}).`,
        );
      }
      const tx = await token.transfer(MARKET_MERCHANT, value);
      const receipt = await tx.wait(1);
      if (receipt?.status !== 1) throw new Error('Transfer transaction failed on-chain.');
      void refreshBalance(address);
      return tx.hash as string;
    },
    [address, ensureChain, refreshBalance],
  );

  return { status, address, usdgBalance, error, connect, disconnect, payUsdg };
}

export { shortAddr };
