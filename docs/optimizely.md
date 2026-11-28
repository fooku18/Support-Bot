# Optimizely

The `optimizely` tool kind lets the agent answer questions about Optimizely
feature flags and A/B tests from the projects' SDK datafiles: whether a flag is
rolled out and for whom, the traffic split, the variations and their variable
values, the audiences and their conditions, whether a test is running, and why
an SDK logs "Feature key … is not in datafile".

It is read-only and needs no credential. Datafiles are the public JSON files
the Optimizely SDKs download from `https://cdn.optimizely.com/datafiles/<sdkKey>.json`.

## Model tool

| Tool                       | What it does                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `optimizely_lookup(query)` | An exact flag key, rule key, experiment ID or variation ID returns each matching flag per configured datafile. Other text searches experiment, flag, delivery rule, audience and event keys (at most 50 matches; experiments first with their status, running ones first). An empty query lists the configured datafiles. |

A flag answer lists the variables with their defaults and the rules in
evaluation order: running experiments first, then the delivery rules, the last
of which applies to everyone else. Each rule shows its audience logic with
audience names and conditions, the traffic per variation in percent, the
variable overrides per variation and the number of whitelisted users. Values of
user ID and e-mail attributes in audience conditions are hidden, and
whitelisted user IDs are never returned. The answer names the datafiles that do
not contain the flag.

A datafile holds no results, metrics, change history or start dates, and no
paused, concluded or archived rules. The tool description tells the model so.

The agent fetches each datafile at most once per five minutes (the SDKs' own
polling interval), with a 10 s deadline, no redirects and a 5 MB cap. Answers
are capped at 48 KB. Code Mode scripts can call it as `external_optimizely_lookup`.

## Set up

1. In the workspace's **Tools** page, add an **Optimizely** instance.
2. Under **Datafiles**, list one line per project environment: the project name
   people use, a space, and the environment's SDK key, for example
   `Shop AbCdEf0123456789`. Each environment has its own key; the agent reads the
   environment name (`production`, `development`) and the project ID from the
   datafile. Find the keys in Optimizely under **Settings → Environments**, or in
   the frontend configuration that loads the SDK.
3. Assign the instance to the channels that may use it.

The instance is ready as soon as it is enabled; there is no runtime probe. A
datafile that cannot be fetched is reported in the answer as unavailable.

## Network

The agent fetches the datafiles itself. In the Compose stack the egress proxy
admits `cdn.optimizely.com` from the tools network. Kubernetes deployments need
egress from the agent pod to `cdn.optimizely.com:443`.
