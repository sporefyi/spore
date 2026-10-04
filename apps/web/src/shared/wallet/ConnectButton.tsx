import { useWallet, shortAddr } from './useWallet';
import { explorerAddressUrl } from '../chains';

/**
 * Wallet connect control for the market store. Renders honest states only:
 * no wallet installed, connecting, wrong network, connected (address +
 * USDG balance + disconnect).
 */
export default function ConnectButton({ wallet }: { wallet: ReturnType<typeof useWallet> }) {
  const { status, address, usdgBalance, error, connect, disconnect } = wallet;

  if (status === 'no-provider') {
    return (
      <div className="border border-rule p-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ember">
          No wallet detected
        </p>
        <p className="mt-2 text-sm text-muted">
          {error ??
            'Install a browser wallet (MetaMask, Rabby, or Coinbase Wallet) to buy from the market.'}
        </p>
      </div>
    );
  }

  if (status === 'connected' && address) {
    return (
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border border-rule px-4 py-3">
        <a
          href={explorerAddressUrl(address)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-sm text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink"
        >
          {shortAddr(address)}
        </a>
        <span className="font-mono text-sm text-muted">
          {usdgBalance === null ? '…' : `${Number(usdgBalance).toFixed(2)} USDG`}
        </span>
        <button
          type="button"
          onClick={disconnect}
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint transition-colors hover:text-ink"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void connect()}
        disabled={status === 'connecting'}
        className="border border-fungal/60 px-6 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-fungal transition-colors hover:bg-fungal/10 disabled:opacity-50"
      >
        {status === 'connecting'
          ? 'Waiting for wallet…'
          : status === 'wrong-chain'
            ? 'Switch to Robinhood Chain'
            : 'Connect wallet'}
      </button>
      {error && <p className="mt-2 font-mono text-[11px] text-ember">{error}</p>}
      {status === 'wrong-chain' && !error && (
        <p className="mt-2 font-mono text-[11px] text-ember">
          Wrong network — approve the switch to Robinhood Chain (4663) in your wallet.
        </p>
      )}
    </div>
  );
}
