import { Service } from 'typedi';
import { snakeCase } from 'change-case';
import os from 'node:os';
import { get as pslGet } from 'psl';
import { GlobalConfig } from '@n8n/config';
import type {
	ExecutionStatus,
	INodesGraphResult,
	IRun,
	ITelemetryTrackProperties,
	IWorkflowBase,
} from 'n8n-workflow';
import { TelemetryHelpers } from 'n8n-workflow';
import { InstanceSettings } from 'n8n-core';

import config from '@/config';
import { N8N_VERSION } from '@/constants';
import type { AuthProviderType } from '@db/entities/AuthIdentity';
import type { User } from '@db/entities/User';
import { SharedWorkflowRepository } from '@db/repositories/sharedWorkflow.repository';
import { WorkflowRepository } from '@db/repositories/workflow.repository';
import { determineFinalExecutionStatus } from '@/executionLifecycleHooks/shared/sharedHookFunctions';
import type {
	ITelemetryUserDeletionData,
	IWorkflowDb,
	IExecutionTrackProperties,
} from '@/Interfaces';
import { License } from '@/License';
import { WorkflowStatisticsService } from '@/services/workflow-statistics.service';
import { NodeTypes } from '@/NodeTypes';
import { Telemetry } from '@/telemetry';
import type { Project } from '@db/entities/Project';
import { ProjectRelationRepository } from './databases/repositories/projectRelation.repository';
import { SharedCredentialsRepository } from './databases/repositories/sharedCredentials.repository';
import { MessageEventBus } from './eventbus/MessageEventBus/MessageEventBus';

/**
 * @deprecated Do not add to this class. To add audit or telemetry events, use
 * `EventService` to emit the event and then use the `AuditEventRelay` or
 * `TelemetryEventRelay` to forward them to the event bus or telemetry.
 */
@Service()
export class InternalHooks {
	constructor(
		private readonly globalConfig: GlobalConfig,
		private readonly telemetry: Telemetry,
		private readonly nodeTypes: NodeTypes,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly workflowRepository: WorkflowRepository,
		workflowStatisticsService: WorkflowStatisticsService,
		private readonly instanceSettings: InstanceSettings,
		private readonly license: License,
		private readonly projectRelationRepository: ProjectRelationRepository,
		private readonly sharedCredentialsRepository: SharedCredentialsRepository,
		private readonly _eventBus: MessageEventBus, // needed until we decouple telemetry
	) {
		workflowStatisticsService.on(
			'telemetry.onFirstProductionWorkflowSuccess',
			async (metrics) => await this.onFirstProductionWorkflowSuccess(metrics),
		);
		workflowStatisticsService.on(
			'telemetry.onFirstWorkflowDataLoad',
			async (metrics) => await this.onFirstWorkflowDataLoad(metrics),
		);
	}

	async init() {
		await this.telemetry.init();
	}

	async onServerStarted(): Promise<unknown[]> {
		const cpus = os.cpus();
		const binaryDataConfig = config.getEnv('binaryDataManager');

		const isS3Selected = config.getEnv('binaryDataManager.mode') === 's3';
		const isS3Available = config.getEnv('binaryDataManager.availableModes').includes('s3');
		const isS3Licensed = this.license.isBinaryDataS3Licensed();
		const authenticationMethod = config.getEnv('userManagement.authenticationMethod');

		const info = {
			version_cli: N8N_VERSION,
			db_type: this.globalConfig.database.type,
			n8n_version_notifications_enabled: this.globalConfig.versionNotifications.enabled,
			n8n_disable_production_main_process: config.getEnv(
				'endpoints.disableProductionWebhooksOnMainProcess',
			),
			system_info: {
				os: {
					type: os.type(),
					version: os.version(),
				},
				memory: os.totalmem() / 1024,
				cpus: {
					count: cpus.length,
					model: cpus[0].model,
					speed: cpus[0].speed,
				},
			},
			execution_variables: {
				executions_mode: config.getEnv('executions.mode'),
				executions_timeout: config.getEnv('executions.timeout'),
				executions_timeout_max: config.getEnv('executions.maxTimeout'),
				executions_data_save_on_error: config.getEnv('executions.saveDataOnError'),
				executions_data_save_on_success: config.getEnv('executions.saveDataOnSuccess'),
				executions_data_save_on_progress: config.getEnv('executions.saveExecutionProgress'),
				executions_data_save_manual_executions: config.getEnv(
					'executions.saveDataManualExecutions',
				),
				executions_data_prune: config.getEnv('executions.pruneData'),
				executions_data_max_age: config.getEnv('executions.pruneDataMaxAge'),
			},
			n8n_deployment_type: config.getEnv('deployment.type'),
			n8n_binary_data_mode: binaryDataConfig.mode,
			smtp_set_up: this.globalConfig.userManagement.emails.mode === 'smtp',
			ldap_allowed: authenticationMethod === 'ldap',
			saml_enabled: authenticationMethod === 'saml',
			license_plan_name: this.license.getPlanName(),
			license_tenant_id: config.getEnv('license.tenantId'),
			binary_data_s3: isS3Available && isS3Selected && isS3Licensed,
			multi_main_setup_enabled: config.getEnv('multiMainSetup.enabled'),
		};

		const firstWorkflow = await this.workflowRepository.findOne({
			select: ['createdAt'],
			order: { createdAt: 'ASC' },
			where: {},
		});

		return await Promise.all([
			this.telemetry.identify(info),
			this.telemetry.track('Instance started', {
				...info,
				earliest_workflow_created: firstWorkflow?.createdAt,
			}),
		]);
	}

	async onFrontendSettingsAPI(pushRef?: string): Promise<void> {
		return await this.telemetry.track('Session started', { session_id: pushRef });
	}

	async onPersonalizationSurveySubmitted(
		userId: string,
		answers: Record<string, string>,
	): Promise<void> {
		const camelCaseKeys = Object.keys(answers);
		const personalizationSurveyData = { user_id: userId } as Record<string, string | string[]>;
		camelCaseKeys.forEach((camelCaseKey) => {
			personalizationSurveyData[snakeCase(camelCaseKey)] = answers[camelCaseKey];
		});

		return await this.telemetry.track(
			'User responded to personalization questions',
			personalizationSurveyData,
		);
	}

	async onWorkflowCreated(
		user: User,
		workflow: IWorkflowBase,
		project: Project,
		publicApi: boolean,
	): Promise<void> {
		const { nodeGraph } = TelemetryHelpers.generateNodesGraph(workflow, this.nodeTypes);

		void this.telemetry.track('User created workflow', {
			user_id: user.id,
			workflow_id: workflow.id,
			node_graph_string: JSON.stringify(nodeGraph),
			public_api: publicApi,
			project_id: project.id,
			project_type: project.type,
		});
	}

	async onWorkflowDeleted(user: User, workflowId: string, publicApi: boolean): Promise<void> {
		void this.telemetry.track('User deleted workflow', {
			user_id: user.id,
			workflow_id: workflowId,
			public_api: publicApi,
		});
	}

	async onWorkflowSaved(user: User, workflow: IWorkflowDb, publicApi: boolean): Promise<void> {
		const isCloudDeployment = config.getEnv('deployment.type') === 'cloud';

		const { nodeGraph } = TelemetryHelpers.generateNodesGraph(workflow, this.nodeTypes, {
			isCloudDeployment,
		});

		let userRole: 'owner' | 'sharee' | 'member' | undefined = undefined;
		const role = await this.sharedWorkflowRepository.findSharingRole(user.id, workflow.id);
		if (role) {
			userRole = role === 'workflow:owner' ? 'owner' : 'sharee';
		} else {
			const workflowOwner = await this.sharedWorkflowRepository.getWorkflowOwningProject(
				workflow.id,
			);

			if (workflowOwner) {
				const projectRole = await this.projectRelationRepository.findProjectRole({
					userId: user.id,
					projectId: workflowOwner.id,
				});

				if (projectRole && projectRole !== 'project:personalOwner') {
					userRole = 'member';
				}
			}
		}

		const notesCount = Object.keys(nodeGraph.notes).length;
		const overlappingCount = Object.values(nodeGraph.notes).filter(
			(note) => note.overlapping,
		).length;

		void this.telemetry.track('User saved workflow', {
			user_id: user.id,
			workflow_id: workflow.id,
			node_graph_string: JSON.stringify(nodeGraph),
			notes_count_overlapping: overlappingCount,
			notes_count_non_overlapping: notesCount - overlappingCount,
			version_cli: N8N_VERSION,
			num_tags: workflow.tags?.length ?? 0,
			public_api: publicApi,
			sharing_role: userRole,
		});
	}

	// eslint-disable-next-line complexity
	async onWorkflowPostExecute(
		_executionId: string,
		workflow: IWorkflowBase,
		runData?: IRun,
		userId?: string,
	): Promise<void> {
		if (!workflow.id) {
			return;
		}

		if (runData?.status === 'waiting') {
			// No need to send telemetry or logs when the workflow hasn't finished yet.
			return;
		}

		const promises = [];

		const telemetryProperties: IExecutionTrackProperties = {
			workflow_id: workflow.id,
			is_manual: false,
			version_cli: N8N_VERSION,
			success: false,
		};

		if (userId) {
			telemetryProperties.user_id = userId;
		}

		if (runData?.data.resultData.error?.message?.includes('canceled')) {
			runData.status = 'canceled';
		}

		telemetryProperties.success = !!runData?.finished;

		// const executionStatus: ExecutionStatus = runData?.status ?? 'unknown';
		const executionStatus: ExecutionStatus = runData
			? determineFinalExecutionStatus(runData)
			: 'unknown';

		if (runData !== undefined) {
			telemetryProperties.execution_mode = runData.mode;
			telemetryProperties.is_manual = runData.mode === 'manual';

			let nodeGraphResult: INodesGraphResult | null = null;

			if (!telemetryProperties.success && runData?.data.resultData.error) {
				telemetryProperties.error_message = runData?.data.resultData.error.message;
				let errorNodeName =
					'node' in runData?.data.resultData.error
						? runData?.data.resultData.error.node?.name
						: undefined;
				telemetryProperties.error_node_type =
					'node' in runData?.data.resultData.error
						? runData?.data.resultData.error.node?.type
						: undefined;

				if (runData.data.resultData.lastNodeExecuted) {
					const lastNode = TelemetryHelpers.getNodeTypeForName(
						workflow,
						runData.data.resultData.lastNodeExecuted,
					);

					if (lastNode !== undefined) {
						telemetryProperties.error_node_type = lastNode.type;
						errorNodeName = lastNode.name;
					}
				}

				if (telemetryProperties.is_manual) {
					nodeGraphResult = TelemetryHelpers.generateNodesGraph(workflow, this.nodeTypes);
					telemetryProperties.node_graph = nodeGraphResult.nodeGraph;
					telemetryProperties.node_graph_string = JSON.stringify(nodeGraphResult.nodeGraph);

					if (errorNodeName) {
						telemetryProperties.error_node_id = nodeGraphResult.nameIndices[errorNodeName];
					}
				}
			}

			if (telemetryProperties.is_manual) {
				if (!nodeGraphResult) {
					nodeGraphResult = TelemetryHelpers.generateNodesGraph(workflow, this.nodeTypes);
				}

				let userRole: 'owner' | 'sharee' | undefined = undefined;
				if (userId) {
					const role = await this.sharedWorkflowRepository.findSharingRole(userId, workflow.id);
					if (role) {
						userRole = role === 'workflow:owner' ? 'owner' : 'sharee';
					}
				}

				const manualExecEventProperties: ITelemetryTrackProperties = {
					user_id: userId,
					workflow_id: workflow.id,
					status: executionStatus,
					executionStatus: runData?.status ?? 'unknown',
					error_message: telemetryProperties.error_message as string,
					error_node_type: telemetryProperties.error_node_type,
					node_graph_string: telemetryProperties.node_graph_string as string,
					error_node_id: telemetryProperties.error_node_id as string,
					webhook_domain: null,
					sharing_role: userRole,
				};

				if (!manualExecEventProperties.node_graph_string) {
					nodeGraphResult = TelemetryHelpers.generateNodesGraph(workflow, this.nodeTypes);
					manualExecEventProperties.node_graph_string = JSON.stringify(nodeGraphResult.nodeGraph);
				}

				if (runData.data.startData?.destinationNode) {
					const telemetryPayload = {
						...manualExecEventProperties,
						node_type: TelemetryHelpers.getNodeTypeForName(
							workflow,
							runData.data.startData?.destinationNode,
						)?.type,
						node_id: nodeGraphResult.nameIndices[runData.data.startData?.destinationNode],
					};

					promises.push(this.telemetry.track('Manual node exec finished', telemetryPayload));
				} else {
					nodeGraphResult.webhookNodeNames.forEach((name: string) => {
						const execJson = runData.data.resultData.runData[name]?.[0]?.data?.main?.[0]?.[0]
							?.json as { headers?: { origin?: string } };
						if (execJson?.headers?.origin && execJson.headers.origin !== '') {
							manualExecEventProperties.webhook_domain = pslGet(
								execJson.headers.origin.replace(/^https?:\/\//, ''),
							);
						}
					});

					promises.push(
						this.telemetry.track('Manual workflow exec finished', manualExecEventProperties),
					);
				}
			}
		}

		void Promise.all([...promises, this.telemetry.trackWorkflowExecution(telemetryProperties)]);
	}

	async onWorkflowSharingUpdate(workflowId: string, userId: string, userList: string[]) {
		const properties: ITelemetryTrackProperties = {
			workflow_id: workflowId,
			user_id_sharer: userId,
			user_id_list: userList,
		};

		return await this.telemetry.track('User updated workflow sharing', properties);
	}

	async onN8nStop(): Promise<void> {
		const timeoutPromise = new Promise<void>((resolve) => {
			setTimeout(() => {
				resolve();
			}, 3000);
		});

		return await Promise.race([timeoutPromise, this.telemetry.trackN8nStop()]);
	}

	async onUserDeletion(userDeletionData: {
		user: User;
		telemetryData: ITelemetryUserDeletionData;
		publicApi: boolean;
	}): Promise<void> {
		void this.telemetry.track('User deleted user', {
			...userDeletionData.telemetryData,
			user_id: userDeletionData.user.id,
			public_api: userDeletionData.publicApi,
		});
	}

	async onUserInvite(userInviteData: {
		user: User;
		target_user_id: string[];
		public_api: boolean;
		email_sent: boolean;
		invitee_role: string;
	}): Promise<void> {
		void this.telemetry.track('User invited new user', {
			user_id: userInviteData.user.id,
			target_user_id: userInviteData.target_user_id,
			public_api: userInviteData.public_api,
			email_sent: userInviteData.email_sent,
			invitee_role: userInviteData.invitee_role,
		});
	}

	async onUserRoleChange(userRoleChangeData: {
		user: User;
		target_user_id: string;
		public_api: boolean;
		target_user_new_role: string;
	}) {
		const { user, ...rest } = userRoleChangeData;

		void this.telemetry.track('User changed role', { user_id: user.id, ...rest });
	}

	async onUserRetrievedUser(userRetrievedData: {
		user_id: string;
		public_api: boolean;
	}): Promise<void> {
		return await this.telemetry.track('User retrieved user', userRetrievedData);
	}

	async onUserRetrievedAllUsers(userRetrievedData: {
		user_id: string;
		public_api: boolean;
	}): Promise<void> {
		return await this.telemetry.track('User retrieved all users', userRetrievedData);
	}

	async onUserRetrievedExecution(userRetrievedData: {
		user_id: string;
		public_api: boolean;
	}): Promise<void> {
		return await this.telemetry.track('User retrieved execution', userRetrievedData);
	}

	async onUserRetrievedAllExecutions(userRetrievedData: {
		user_id: string;
		public_api: boolean;
	}): Promise<void> {
		return await this.telemetry.track('User retrieved all executions', userRetrievedData);
	}

	async onUserRetrievedWorkflow(userRetrievedData: {
		user_id: string;
		public_api: boolean;
	}): Promise<void> {
		return await this.telemetry.track('User retrieved workflow', userRetrievedData);
	}

	async onUserRetrievedAllWorkflows(userRetrievedData: {
		user_id: string;
		public_api: boolean;
	}): Promise<void> {
		return await this.telemetry.track('User retrieved all workflows', userRetrievedData);
	}

	async onUserUpdate(userUpdateData: { user: User; fields_changed: string[] }): Promise<void> {
		void this.telemetry.track('User changed personal settings', {
			user_id: userUpdateData.user.id,
			fields_changed: userUpdateData.fields_changed,
		});
	}

	async onUserInviteEmailClick(userInviteClickData: {
		inviter: User;
		invitee: User;
	}): Promise<void> {
		void this.telemetry.track('User clicked invite link from email', {
			user_id: userInviteClickData.invitee.id,
		});
	}

	async onUserPasswordResetEmailClick(userPasswordResetData: { user: User }): Promise<void> {
		void this.telemetry.track('User clicked password reset link from email', {
			user_id: userPasswordResetData.user.id,
		});
	}

	async onUserTransactionalEmail(userTransactionalEmailData: {
		user_id: string;
		message_type:
			| 'Reset password'
			| 'New user invite'
			| 'Resend invite'
			| 'Workflow shared'
			| 'Credentials shared';
		public_api: boolean;
	}): Promise<void> {
		return await this.telemetry.track(
			'Instance sent transactional email to user',
			userTransactionalEmailData,
		);
	}

	async onUserPasswordResetRequestClick(userPasswordResetData: { user: User }): Promise<void> {
		void this.telemetry.track('User requested password reset while logged out', {
			user_id: userPasswordResetData.user.id,
		});
	}

	async onInstanceOwnerSetup(instanceOwnerSetupData: { user_id: string }): Promise<void> {
		return await this.telemetry.track('Owner finished instance setup', instanceOwnerSetupData);
	}

	async onUserSignup(
		user: User,
		userSignupData: {
			user_type: AuthProviderType;
			was_disabled_ldap_user: boolean;
		},
	): Promise<void> {
		void this.telemetry.track('User signed up', {
			user_id: user.id,
			...userSignupData,
		});
	}

	async onEmailFailed(failedEmailData: {
		user: User;
		message_type:
			| 'Reset password'
			| 'New user invite'
			| 'Resend invite'
			| 'Workflow shared'
			| 'Credentials shared';
		public_api: boolean;
	}): Promise<void> {
		void this.telemetry.track('Instance failed to send transactional email to user', {
			user_id: failedEmailData.user.id,
		});
	}

	/**
	 * Credentials
	 */

	async onUserCreatedCredentials(userCreatedCredentialsData: {
		user: User;
		credential_name: string;
		credential_type: string;
		credential_id: string;
		public_api: boolean;
	}): Promise<void> {
		const project = await this.sharedCredentialsRepository.findCredentialOwningProject(
			userCreatedCredentialsData.credential_id,
		);
		void this.telemetry.track('User created credentials', {
			user_id: userCreatedCredentialsData.user.id,
			credential_type: userCreatedCredentialsData.credential_type,
			credential_id: userCreatedCredentialsData.credential_id,
			instance_id: this.instanceSettings.instanceId,
			project_id: project?.id,
			project_type: project?.type,
		});
	}

	async onUserSharedCredentials(userSharedCredentialsData: {
		user: User;
		credential_name: string;
		credential_type: string;
		credential_id: string;
		user_id_sharer: string;
		user_ids_sharees_added: string[];
		sharees_removed: number | null;
	}): Promise<void> {
		void this.telemetry.track('User updated cred sharing', {
			user_id: userSharedCredentialsData.user.id,
			credential_type: userSharedCredentialsData.credential_type,
			credential_id: userSharedCredentialsData.credential_id,
			user_id_sharer: userSharedCredentialsData.user_id_sharer,
			user_ids_sharees_added: userSharedCredentialsData.user_ids_sharees_added,
			sharees_removed: userSharedCredentialsData.sharees_removed,
			instance_id: this.instanceSettings.instanceId,
		});
	}

	async onUserUpdatedCredentials(userUpdatedCredentialsData: {
		user: User;
		credential_name: string;
		credential_type: string;
		credential_id: string;
	}): Promise<void> {
		void this.telemetry.track('User updated credentials', {
			user_id: userUpdatedCredentialsData.user.id,
			credential_type: userUpdatedCredentialsData.credential_type,
			credential_id: userUpdatedCredentialsData.credential_id,
		});
	}

	async onUserDeletedCredentials(userUpdatedCredentialsData: {
		user: User;
		credential_name: string;
		credential_type: string;
		credential_id: string;
	}): Promise<void> {
		void this.telemetry.track('User deleted credentials', {
			user_id: userUpdatedCredentialsData.user.id,
			credential_type: userUpdatedCredentialsData.credential_type,
			credential_id: userUpdatedCredentialsData.credential_id,
			instance_id: this.instanceSettings.instanceId,
		});
	}

	/*
	 * Execution Statistics
	 */
	async onFirstProductionWorkflowSuccess(data: {
		user_id: string;
		workflow_id: string;
	}): Promise<void> {
		return await this.telemetry.track('Workflow first prod success', data);
	}

	async onFirstWorkflowDataLoad(data: {
		user_id: string;
		workflow_id: string;
		node_type: string;
		node_id: string;
		credential_type?: string;
		credential_id?: string;
	}): Promise<void> {
		return await this.telemetry.track('Workflow first data fetched', data);
	}
}
