import { Service, GoldenConfig, Stack } from '@ambita/golden';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { RemovalPolicy } from 'aws-cdk-lib';

const cfg = new GoldenConfig();
const stack = new Stack(cfg);

// DynamoDB table for storing sync configs and repo states
const stateTable = new dynamodb.Table(stack, 'StateTable', {
  tableName: `github-migrate-state-${cfg.env.name}`,
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  removalPolicy: cfg.env.name === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
  pointInTimeRecovery: true,
});

// GSI for querying repos by syncId
stateTable.addGlobalSecondaryIndex({
  indexName: 'syncId-index',
  partitionKey: { name: 'syncId', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});

// SSM Parameter path for GitHub PATs (stored as SecureString JSON)
// Format: { "syncs": { "<syncId>": { "sourceToken": "...", "targetToken": "..." } } }
const patsParameterName = `/container/git-migrate/${cfg.env.name}/secrets/github-pats`;

new Service(stack, cfg, {
  image: 'local',
  dockerfileBuildDirectory: 'dist',
  
  endpoints: [{
    alb: 'api',
    host: 'github-migrate.ambita.com',
    priority: 160,
    dns: true,
    sso: true,
    oidc: {
      provider: 'spirgroup',
    },
  }],

  scaling: 'singleInstance',
  port: 3000,

  cpu: 512,
  memory: 1024,

  healthCheck: {
    path: '/api/health',
    startup: 10,
    timeout: 3,
    interval: 10,
  },

  environment: {
    DYNAMODB_TABLE: stateTable.tableName,
    SSM_PATS_PARAMETER: patsParameterName,
    NODE_ENV: 'production',
  },

  policyStatements: [
    // DynamoDB access
    {
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        'dynamodb:Scan',
        'dynamodb:BatchGetItem',
        'dynamodb:BatchWriteItem',
      ],
      resources: [
        stateTable.tableArn,
        `${stateTable.tableArn}/index/*`,
      ],
    },
    // SSM Parameter Store access for PATs
    {
      actions: [
        'ssm:GetParameter',
        'ssm:PutParameter',
      ],
      resources: [
        `arn:aws:ssm:${stack.region}:${stack.account}:parameter/container/git-migrate/${cfg.env.name}/secrets/*`,
      ],
    },
    // KMS decrypt/encrypt for SecureString parameters
    {
      actions: ['kms:Decrypt', 'kms:Encrypt'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'kms:ViaService': `ssm.${stack.region}.amazonaws.com`,
        },
      },
    },
  ],

  alarms: false,
  circuitBreaker: false,
  
  // Disable telemetry sidecars for simpler debugging
  telemetry: {
    enable: false,
  },
  logging: {
    enable: false,
  },
});
