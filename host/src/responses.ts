export interface SubmissionAcknowledgement {
  requestId: string;
  conversationId: string;
  taskId: string | null;
  state: string;
  detail: string;
  transcript?: string;
}
