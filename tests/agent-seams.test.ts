/** @jest-environment node */
import * as hash from '@/utils/hash';
import * as sanitize from '@/utils/sanitize';
import * as value from '@/utils/value';
import * as redact from '@/utils/redact';
import * as commands from '@/agent/commands';
import * as resolver from '@/agent/resolver';
import * as policy from '@/agent/policy';
import * as verify from '@/agent/verify';
import * as request from '@/agent/request';
import * as typesafe from '@/agent/typesafe';
import * as remote from '@/agent/RemoteTaskHost';
import * as coordinator from '@/agent/TaskAgent';
import * as bridge from '@/agent/browser/bridge';
import * as host from '@/agent/browser/AutomationTaskHost';
import * as research from '@/agent/research';
import type {
  TaskAddRunGrantsFn,
  TaskAllCommitmentsGrantedFn,
  TaskArgumentAvailableFn,
  TaskArgumentViewFn,
  TaskAssertGoalPreservedFn,
  TaskBuildActionQuestionsFn,
  TaskBuildArgumentQuestionsFn,
  TaskBuildCandidatesFn,
  TaskBuildCommitmentQuestionsFn,
  TaskBuildCompletionQuestionsFn,
  TaskCandidateViewsFn,
  TaskCapFieldValueFn,
  TaskCheckPostconditionsFn,
  TaskCollectEvidenceFn,
  TaskCommandDigestFn,
  TaskCommitContextFn,
  TaskCompareFieldValuesFn,
  TaskCompileCommandFn,
  TaskCompletionFromReportFn,
  TaskComputeOffersFn,
  TaskConsumeGrantsFn,
  TaskContextDigestFn,
  TaskCreateAgentFn,
  TaskCreateAutomationHostFn,
  TaskCreateLedgerEntryFn,
  TaskCreatePolicyFn,
  TaskCreateRedactorFn,
  TaskCreateRemoteHostFn,
  TaskCreateResearchRequestFn,
  TaskCreateTypeSafeDeciderFn,
  TaskDerivePostconditionsFn,
  TaskDerivedIdFn,
  TaskDescribeArgumentFn,
  TaskEffectForCommitmentFn,
  TaskEstimateRequestBytesFn,
  TaskEstimateRequestTokensFn,
  TaskEvaluateGateFn,
  TaskExpectedStatesFn,
  TaskFlattenInputsFn,
  TaskHasUnsafeKeyFn,
  TaskHashStringFn,
  TaskHistoryFromLedgerFn,
  TaskHmacSha256HexFn,
  TaskInputRulesFn,
  TaskInstallBridgeFn,
  TaskIsSensitiveKeyFn,
  TaskMaterializeArgumentFn,
  TaskMergeEffectsFn,
  TaskMergeInputsFn,
  TaskNormalizeAuthorizationFn,
  TaskNormalizeOutcomeFn,
  TaskPendingCommitmentsFn,
  TaskRedactCommandFn,
  TaskRedactEnvelopeFn,
  TaskRedactParametersFn,
  TaskResolveUncertainFn,
  TaskSanitizeUntrustedTextFn,
  TaskSha256HexFn,
  TaskSplitSensitiveInputsFn,
  TaskStableStringifyFn,
  TaskSummarizeInputsFn,
  TaskSummarizeObservationFn,
  TaskToActionCommandFn,
  TaskToHostCommandFn,
  TaskToResearchResultFn,
} from '@/types';
const hash_hashString: TaskHashStringFn = hash.hashString;
const hash_sha256Hex: TaskSha256HexFn = hash.sha256Hex;
const hash_hmacSha256Hex: TaskHmacSha256HexFn = hash.hmacSha256Hex;
const hash_derivedId: TaskDerivedIdFn = hash.derivedId;
const hash_stableStringify: TaskStableStringifyFn = hash.stableStringify;
const sanitize_sanitizeUntrustedText: TaskSanitizeUntrustedTextFn = sanitize.sanitizeUntrustedText;
const value_capFieldValue: TaskCapFieldValueFn = value.capFieldValue;
const value_compareFieldValues: TaskCompareFieldValuesFn = value.compareFieldValues;
const redact_isSensitiveKey: TaskIsSensitiveKeyFn = redact.isSensitiveKey;
const redact_redactParameters: TaskRedactParametersFn = redact.redactParameters;
const redact_createRedactor: TaskCreateRedactorFn = redact.createRedactor;
const redact_redactEnvelope: TaskRedactEnvelopeFn = redact.redactEnvelope;
const commands_describeArgument: TaskDescribeArgumentFn = commands.describeArgument;
const commands_computeOffers: TaskComputeOffersFn = commands.computeOffers;
const commands_compileCommand: TaskCompileCommandFn = commands.compileCommand;
const commands_commandDigest: TaskCommandDigestFn = commands.commandDigest;
const commands_commitContext: TaskCommitContextFn = commands.commitContext;
const commands_contextDigest: TaskContextDigestFn = commands.contextDigest;
const commands_redactCommand: TaskRedactCommandFn = commands.redactCommand;
const commands_toHostCommand: TaskToHostCommandFn = commands.toHostCommand;
const commands_toActionCommand: TaskToActionCommandFn = commands.toActionCommand;
const resolver_hasUnsafeKey: TaskHasUnsafeKeyFn = resolver.hasUnsafeKey;
const resolver_flattenInputs: TaskFlattenInputsFn = resolver.flattenInputs;
const resolver_inputRules: TaskInputRulesFn = resolver.inputRules;
const resolver_summarizeInputs: TaskSummarizeInputsFn = resolver.summarizeInputs;
const resolver_buildCandidates: TaskBuildCandidatesFn = resolver.buildCandidates;
const resolver_candidateViews: TaskCandidateViewsFn = resolver.candidateViews;
const resolver_argumentView: TaskArgumentViewFn = resolver.argumentView;
const resolver_argumentAvailable: TaskArgumentAvailableFn = resolver.argumentAvailable;
const resolver_materializeArgument: TaskMaterializeArgumentFn = resolver.materializeArgument;
const resolver_mergeInputs: TaskMergeInputsFn = resolver.mergeInputs;
const resolver_splitSensitiveInputs: TaskSplitSensitiveInputsFn = resolver.splitSensitiveInputs;
const policy_mergeEffects: TaskMergeEffectsFn = policy.mergeEffects;
const policy_effectForCommitment: TaskEffectForCommitmentFn = policy.effectForCommitment;
const policy_createTaskPolicy: TaskCreatePolicyFn = policy.createTaskPolicy;
const policy_normalizeAuthorization: TaskNormalizeAuthorizationFn = policy.normalizeAuthorization;
const policy_addRunGrants: TaskAddRunGrantsFn = policy.addRunGrants;
const policy_consumeGrants: TaskConsumeGrantsFn = policy.consumeGrants;
const policy_allCommitmentsGranted: TaskAllCommitmentsGrantedFn = policy.allCommitmentsGranted;
const verify_derivePostconditions: TaskDerivePostconditionsFn = verify.derivePostconditions;
const verify_normalizeOutcome: TaskNormalizeOutcomeFn = verify.normalizeOutcome;
const verify_createLedgerEntry: TaskCreateLedgerEntryFn = verify.createLedgerEntry;
const verify_checkPostconditions: TaskCheckPostconditionsFn = verify.checkPostconditions;
const verify_resolveUncertain: TaskResolveUncertainFn = verify.resolveUncertain;
const verify_pendingCommitments: TaskPendingCommitmentsFn = verify.pendingCommitments;
const verify_collectEvidence: TaskCollectEvidenceFn = verify.collectEvidence;
const verify_expectedStates: TaskExpectedStatesFn = verify.expectedStates;
const verify_summarizeObservation: TaskSummarizeObservationFn = verify.summarizeObservation;
const verify_evaluateLocalGate: TaskEvaluateGateFn = verify.evaluateLocalGate;
const verify_evaluateFullGate: TaskEvaluateGateFn = verify.evaluateFullGate;
const verify_completionFromReport: TaskCompletionFromReportFn = verify.completionFromReport;
const verify_historyFromLedger: TaskHistoryFromLedgerFn = verify.historyFromLedger;
const request_estimateRequestBytes: TaskEstimateRequestBytesFn = request.estimateRequestBytes;
const request_estimateRequestTokens: TaskEstimateRequestTokensFn = request.estimateRequestTokens;
const request_assertGoalPreserved: TaskAssertGoalPreservedFn = request.assertGoalPreserved;
const request_buildActionQuestions: TaskBuildActionQuestionsFn = request.buildActionQuestions;
const request_buildArgumentQuestions: TaskBuildArgumentQuestionsFn = request.buildArgumentQuestions;
const request_buildCommitmentQuestions: TaskBuildCommitmentQuestionsFn =
  request.buildCommitmentQuestions;
const request_buildCompletionQuestions: TaskBuildCompletionQuestionsFn =
  request.buildCompletionQuestions;
const typesafe_createTypeSafeTaskDecider: TaskCreateTypeSafeDeciderFn =
  typesafe.createTypeSafeTaskDecider;
const remote_createRemoteTaskHost: TaskCreateRemoteHostFn = remote.createRemoteTaskHost;
const coordinator_createTaskAgent: TaskCreateAgentFn = coordinator.createTaskAgent;
const bridge_installTaskBridge: TaskInstallBridgeFn<HTMLElement> = bridge.installTaskBridge;
const host_createAutomationTaskHost: TaskCreateAutomationHostFn<HTMLElement> =
  host.createAutomationTaskHost;
const research_createResearchRequest: TaskCreateResearchRequestFn = research.createResearchRequest;
const research_toResearchResult: TaskToResearchResultFn = research.toResearchResult;

const seams = {
  hash_hashString,
  hash_sha256Hex,
  hash_hmacSha256Hex,
  hash_derivedId,
  hash_stableStringify,
  sanitize_sanitizeUntrustedText,
  value_capFieldValue,
  value_compareFieldValues,
  redact_isSensitiveKey,
  redact_redactParameters,
  redact_createRedactor,
  redact_redactEnvelope,
  commands_describeArgument,
  commands_computeOffers,
  commands_compileCommand,
  commands_commandDigest,
  commands_commitContext,
  commands_contextDigest,
  commands_redactCommand,
  commands_toHostCommand,
  commands_toActionCommand,
  resolver_hasUnsafeKey,
  resolver_flattenInputs,
  resolver_inputRules,
  resolver_summarizeInputs,
  resolver_buildCandidates,
  resolver_candidateViews,
  resolver_argumentView,
  resolver_argumentAvailable,
  resolver_materializeArgument,
  resolver_mergeInputs,
  resolver_splitSensitiveInputs,
  policy_mergeEffects,
  policy_effectForCommitment,
  policy_createTaskPolicy,
  policy_normalizeAuthorization,
  policy_addRunGrants,
  policy_consumeGrants,
  policy_allCommitmentsGranted,
  verify_derivePostconditions,
  verify_normalizeOutcome,
  verify_createLedgerEntry,
  verify_checkPostconditions,
  verify_resolveUncertain,
  verify_pendingCommitments,
  verify_collectEvidence,
  verify_expectedStates,
  verify_summarizeObservation,
  verify_evaluateLocalGate,
  verify_evaluateFullGate,
  verify_completionFromReport,
  verify_historyFromLedger,
  request_estimateRequestBytes,
  request_estimateRequestTokens,
  request_assertGoalPreserved,
  request_buildActionQuestions,
  request_buildArgumentQuestions,
  request_buildCommitmentQuestions,
  request_buildCompletionQuestions,
  typesafe_createTypeSafeTaskDecider,
  remote_createRemoteTaskHost,
  coordinator_createTaskAgent,
  bridge_installTaskBridge,
  host_createAutomationTaskHost,
  research_createResearchRequest,
  research_toResearchResult,
};

test.each(Object.entries(seams))('%s matches its public seam and is callable', (_name, value) => {
  expect(typeof value).toBe('function');
});
