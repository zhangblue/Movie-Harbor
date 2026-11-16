import { apiRequest, requiredResponse } from "./http";
import type { AgentAccountRole, AgentAuditAccount, AgentHistory, AgentReply } from "./types";

// 使用对应会话的同源接口发送消息，聊天上下文由服务端加载。
export async function chatWithAgent(role: AgentAccountRole, message: string): Promise<AgentReply> {
  return requiredResponse(await apiRequest<AgentReply, { message: string }>(`/api/${role}/agent/chat`, {
    method: "POST", json: { message },
  }));
}

// 打开聊天框或翻页时，获取当前会话对应账号的问答。
export async function listAgentHistory(role: AgentAccountRole, before?: string): Promise<AgentHistory> {
  return requiredResponse(await apiRequest<AgentHistory>(`/api/${role}/agent/history`, { query: { before } }));
}

// 在管理员打开审阅页时获取有对话的账号及其轮数。
export async function listAgentAuditAccounts(): Promise<AgentAuditAccount[]> {
  return requiredResponse(await apiRequest<AgentAuditAccount[]>("/api/admin/agent/audit/accounts"));
}

// 在管理员选择账号或翻页时获取该账号的问答。
export async function listAgentAudit(account: AgentAuditAccount, before?: string): Promise<AgentHistory> {
  return requiredResponse(await apiRequest<AgentHistory>("/api/admin/agent/audit", {
    query: { account_id: account.id, account_role: account.account_role, before },
  }));
}
