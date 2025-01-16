export interface QuestionFrequency {
  question: string;
  count: number;
}

export interface ClusteringResult {
  questions: QuestionFrequency[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    estimated_cost_usd: number;
  };
}
