import { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { SYNDICATE_MANAGER, ROBINHOOD_RPC_URL, USDG } from '../shared/chains';

const DEPLOYED = SYNDICATE_MANAGER !== '0x0000000000000000000000000000000000000000';

// Minimal ABI: only the view functions the page needs.
const ABI = [
  'function nextLoanId() view returns (uint256)',
  'function loans(uint256) view returns (uint256 agentId, address borrower, uint256 target, uint256 funded, uint256 repaid, uint256 claimBase, uint256 feeBps, uint256 fundingDeadline, uint256 repayDeadline, uint8 status, string purpose)',
  'function totalOwed(uint256 loanId) view returns (uint256)',
];

export const STATUS_LABEL = ['Funding', 'Active', 'Repaid', 'Defaulted', 'Cancelled'] as const;

export type LoanView = {
  id: number;
  agentId: number;
  borrower: string;
  target: number;
  funded: number;
  repaid: number;
  feeBps: number;
  fundingDeadline: number;
  repayDeadline: number;
  status: number;
  purpose: string;
  totalOwed: number;
};

export type LoansState =
  | { kind: 'not-deployed' }
  | { kind: 'loading' }
  | { kind: 'ready'; loans: LoanView[] }
  | { kind: 'error'; message: string };

const fmtUsdg = (raw: bigint) => Number(ethers.formatUnits(raw, USDG.decimals));

export function useSyndicateLoans(): LoansState {
  const [state, setState] = useState<LoansState>(
    DEPLOYED ? { kind: 'loading' } : { kind: 'not-deployed' }
  );

  useEffect(() => {
    if (!DEPLOYED) return;
    let alive = true;
    (async () => {
      try {
        const provider = new ethers.JsonRpcProvider(ROBINHOOD_RPC_URL);
        const c = new ethers.Contract(SYNDICATE_MANAGER, ABI, provider);
        const nextId: bigint = await c.nextLoanId();
        const loans: LoanView[] = [];
        for (let i = 1n; i < nextId; i++) {
          const [agentId, borrower, target, funded, repaid, , feeBps, fundingDeadline, repayDeadline, status, purpose] =
            await c.loans(i);
          const owed: bigint = await c.totalOwed(i);
          loans.push({
            id: Number(i),
            agentId: Number(agentId),
            borrower,
            target: fmtUsdg(target),
            funded: fmtUsdg(funded),
            repaid: fmtUsdg(repaid),
            feeBps: Number(feeBps),
            fundingDeadline: Number(fundingDeadline),
            repayDeadline: Number(repayDeadline),
            status: Number(status),
            purpose,
            totalOwed: fmtUsdg(owed),
          });
        }
        if (alive) setState({ kind: 'ready', loans: loans.reverse() });
      } catch (e) {
        if (alive) setState({ kind: 'error', message: e instanceof Error ? e.message : 'read failed' });
      }
    })();
    return () => { alive = false; };
  }, []);

  return state;
}
