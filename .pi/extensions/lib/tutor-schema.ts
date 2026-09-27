import { Type } from "typebox";
export const TaskSchema = Type.Object({
  probe: Type.Optional(Type.Object({
    alternatives: Type.Array(Type.String({minLength:1}), {minItems:2,maxItems:3}),
    separatesBy: Type.String({minLength:1,description:"Different observable answers predicted by the competing explanations; internal only"}),
  })),
  depth: Type.Optional(Type.Integer({minimum:1,maximum:4,description:"1 recognition, 2 explanation, 3 independent application, 4 transfer/critical test"})),
  caseId: Type.Optional(Type.String({description:"Same id for repeated versions of the same case"})),
  alternativeCheck: Type.Optional(Type.String({description:"For conceptual cases: plausible competing answer and why evidence distinguishes it, or explicitly insufficient data. Do not invent exclusivity."})),
  skill: Type.String({ minLength: 1 }), family: Type.String({ minLength: 1 }),
  prerequisites: Type.Optional(Type.Array(Type.String())),
  mode: Type.Union(["worked", "completion", "independent", "mixed", "retrieval"].map(v => Type.Literal(v))),
  shownSteps: Type.Optional(Type.Array(Type.String())), remainingSteps: Type.Optional(Type.Array(Type.String())),
  rubric: Type.Array(Type.String(), { minItems: 1 }),
  assistance: Type.Union(["none", "hint", "worked"].map(v => Type.Literal(v))),
  verification: Type.String({ minLength: 1, description: "How the expected answer was checked: computation/substitution/source; explicitly state uncertainty." }),
});

export const DiagnosisSchema = Type.Object({
  hypothesis: Type.String({minLength:1,maxLength:400}),
  status: Type.Union(["suspected","supported","rejected"].map(v=>Type.Literal(v))),
  basis: Type.String({minLength:1,maxLength:500,description:"Observed evidence for this cause, distinct from merely getting the answer wrong"}),
});

export const ReasoningAuditSchema = Type.Array(Type.Object({
  observed: Type.String({minLength:1,maxLength:500,description:"Concrete step or causal claim made by the learner; paraphrase allowed, no new diagnosis from silence"}),
  expected: Type.String({minLength:1,maxLength:500,description:"Check against problem data: substitution, counterexample, or competing explanation. Not a claim that a source was checked."}),
  verdict: Type.Union(["supported","contradicted","insufficient"].map(v=>Type.Literal(v))),
}),{minItems:1,maxItems:3,description:"Audit decisive steps before choosing the next topic; internal only. Separate correct result from incorrect reasoning."});

export const AssessmentFields = {
  diagnosis: Type.Optional(DiagnosisSchema), audit: Type.Optional(ReasoningAuditSchema),
  result: Type.Union(["correct", "partial", "incorrect", "uncertain"].map(v=>Type.Literal(v))),
  reasoning: Type.Union(["sound", "partial", "incorrect", "unobserved"].map(v=>Type.Literal(v))),
  evidence: Type.Optional(Type.String({minLength:1,description:"Exact excerpt, or omit to use the stored answer"})),
  nextCheck: Type.String({minLength:1}),
};
export const ResolveSupportSchema = Type.Object({
  basis: Type.String({minLength:1,description:"Observed reason for ending local help; does not certify mastery"}),
  nextStep: Type.String({minLength:1,description:"Substantive next step under the existing session contract"}),
});
