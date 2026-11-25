import { AsyncLocalStorage } from "node:async_hooks";
import { SlkyError } from "./errors.js";

export interface SlackRequestBudget {
  limit: number;
  used: number;
}

const currentBudget = new AsyncLocalStorage<SlackRequestBudget>();

export function withSlackRequestBudget<T>(limit: number, operation: (budget: SlackRequestBudget) => Promise<T>): Promise<T> {
  const budget = { limit, used: 0 };
  return currentBudget.run(budget, operation, budget);
}

export function slackRequestAvailable(): boolean {
  const budget = currentBudget.getStore();
  return !budget || budget.used < budget.limit;
}

export function countSlackRequest(): void {
  const budget = currentBudget.getStore();
  if (!budget) return;
  if (budget.used >= budget.limit) throw new SlkyError({ code: "SLACK_REQUEST_BUDGET_EXHAUSTED", message: "The command reached its Slack request limit." });
  budget.used += 1;
}
