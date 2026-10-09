# @mercury-fw/channel-google-chat

Puts a [Mercury](https://github.com/lucabro81/mercury-fw) agent on Google Chat as a registered Chat app: it receives messages through a Pub/Sub subscription and replies through the Chat API, with status cards while it works and a button for the actions that need confirmation.

```bash
bun add @mercury-fw/channel-google-chat
```

Added by hand (an app made with `mfw create` has this already), the channel brings in `protobufjs` (through Google's Pub/Sub client), whose install script Bun blocks unless the app trusts it, so add it to `trustedDependencies` in the app's `package.json`:

```json
"trustedDependencies": ["protobufjs"]
```

```ts
import { googleChatChannel } from "@mercury-fw/channel-google-chat";

channels: [googleChatChannel],
```

| Variable | |
|---|---|
| `GOOGLE_CHAT_PUBSUB_SUBSCRIPTION` | `projects/<project>/subscriptions/<subscription>` the Chat app's events arrive on. Empty leaves the channel inert. |
| `GOOGLE_CHAT_APP_CLIENT_EMAIL` | The service account the app authenticates as. |
| `GOOGLE_CHAT_APP_PRIVATE_KEY` | That service account's private key, on one line with literal `\n` (step 5 writes it that way). |

Each message reaches the core as `google-chat:users/<id>`, the sender's Chat user, with their email when Google vouches for it (a person's, never a bot's), which a user directory can join on: the ZITADEL directory of `@mercury-fw/plugin-zitadel` does.

## Table of contents

- [Setting up the Chat app](#setting-up-the-chat-app)
  - [1. Name things](#1-name-things)
  - [2. Create the project](#2-create-the-project)
  - [3. Create the topic, and let Google Chat publish on it](#3-create-the-topic-and-let-google-chat-publish-on-it)
  - [4. Create the subscription](#4-create-the-subscription)
  - [5. Create the service account and its key](#5-create-the-service-account-and-its-key)
  - [6. Configure the consent screen (Cloud Console)](#6-configure-the-consent-screen-cloud-console)
  - [7. Configure the Chat app (Cloud Console)](#7-configure-the-chat-app-cloud-console)
  - [8. Start and try it](#8-start-and-try-it)
- [Connecting an app to an existing Chat app](#connecting-an-app-to-an-existing-chat-app)
- [When the subscription disappears](#when-the-subscription-disappears)

## Setting up the Chat app

Each Mercury instance needs a Chat app of its own: its own Google Cloud project, Pub/Sub topic, subscription and service account. Two instances on one subscription either both answer or split a conversation between them, each with no memory of the other's half.

Everything goes through `gcloud` except two pages of Cloud Console (steps 6 and 7), which have no command or API. You need:

- a Google Workspace Business or Enterprise account: Chat apps don't exist for personal Gmail accounts;
- `gcloud` logged in with that account (`gcloud auth login <you@company.com>`), allowed to create projects and link a billing account;
- the app with its dependencies installed (`bun install`), for `mfw` in step 5.

### 1. Name things

Every command below reads these variables, so set them once in the shell you'll run the steps from:

```bash
PROJECT_ID=<a new project id, globally unique>
BILLING_ACCOUNT_ID=<from: gcloud billing accounts list>
TOPIC=mercury-chat-events
SUBSCRIPTION=mercury-chat-sub
SA_NAME=mercury-bot
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
```

### 2. Create the project

Pub/Sub needs billing on the project even when its usage stays inside the free tier.

```bash
gcloud projects create "$PROJECT_ID" --name="Mercury"
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID"
gcloud services enable chat.googleapis.com pubsub.googleapis.com iam.googleapis.com --project="$PROJECT_ID"
```

### 3. Create the topic, and let Google Chat publish on it

Google Chat delivers the app's events by publishing them on this topic as its own service account, `chat-api-push@system.gserviceaccount.com`, which needs the publisher role there.

```bash
gcloud pubsub topics create "$TOPIC" --project="$PROJECT_ID"
gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:chat-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

### 4. Create the subscription

`--expiration-period=never` matters: by default Pub/Sub deletes a subscription nobody has pulled from in 31 days, so an instance that stays off for a month would come back to a `NOT_FOUND` (see [When the subscription disappears](#when-the-subscription-disappears)).

```bash
gcloud pubsub subscriptions create "$SUBSCRIPTION" --topic="$TOPIC" --expiration-period=never --project="$PROJECT_ID"
```

### 5. Create the service account and its key

The service account is who Mercury runs as: it reads the subscription and posts to Chat. It needs the subscriber role on the subscription and nothing on the project.

```bash
gcloud iam service-accounts create "$SA_NAME" --project="$PROJECT_ID" --display-name="Mercury bot"
gcloud pubsub subscriptions add-iam-policy-binding "$SUBSCRIPTION" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/pubsub.subscriber"
gcloud iam service-accounts keys create key.json --iam-account="$SA_EMAIL" --project="$PROJECT_ID"
```

A service account takes a few seconds to become visible to the rest of Google Cloud: if the binding fails saying the account doesn't exist, wait a moment and run it again.

Then, from the app's folder, write the key and the subscription into its `.env` with the app's own CLI, and delete the key file. The command replaces the lines `mfw create` left empty (or an older key), puts the private key on one line the way the channel reads it, and never prints it:

```bash
mfw google-chat set-key key.json --subscription "projects/${PROJECT_ID}/subscriptions/${SUBSCRIPTION}"
rm key.json
```

### 6. Configure the consent screen (Cloud Console)

Open [Google Auth Platform → Branding](https://console.cloud.google.com/auth/branding) with the project selected (the project picker is at the top of the page), click **Get Started**, then:

1. **App name**: what users see, e.g. `Mercury`. **User support email**: your address. Click **Next**.
2. **Audience**: pick **Internal**. Click **Next**.
3. **Contact Information**: your address. Click **Next**.
4. Check **I agree to the Google API Services: User Data Policy**, click **Continue**, then **Create**.

No scopes to add: an internal app doesn't list them.

### 7. Configure the Chat app (Cloud Console)

Open the Chat API's configuration page for the project, `https://console.developers.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=<PROJECT_ID>` (or **APIs & Services → Enabled APIs & Services → Google Chat API → Configuration**), and set:

1. **Build this Chat app as a Google Workspace add-on**: unchecked (confirm in the dialog if it asks).
2. **App name**: the name users search for in Chat (up to 25 characters). **Avatar URL**: an HTTPS link to a square image. **Description**: one line (up to 40 characters).
3. **Interactive features**: enabled. Without them nobody can write to the app or click its confirmation buttons.
4. **Functionality**: check **Join spaces and group conversations**.
5. **Connection settings**: pick **Cloud Pub/Sub** and paste the topic's full name, `projects/<PROJECT_ID>/topics/<TOPIC>`.
6. **Visibility**: check **Make this Google Chat app available to specific people and groups in <your domain>** and enter who can use it (people or a group).
7. **Logs**: check **Log errors to Logging**, so a delivery error from Chat shows up in the project's logs.

Click **Save**. The field names here come from Google's own Pub/Sub quickstart; Console moves things around now and then, so trust the meaning over the exact position.

### 8. Start and try it

Start the app (`mfw start`) and check that the channel came up without errors:

```bash
mfw logs mercury
```

`[channel] google-chat started` with no `pubsub stream error` after it means Mercury is pulling from the subscription. Then, in Google Chat, start a new chat and search the app's name (it shows up only for the people and groups in **Visibility**), or add it to a space; write to it and it answers.

## Connecting an app to an existing Chat app

When the Chat app is already set up and the Mercury instance behind it changes (the app scaffolded again, or moved to another machine), the new app only needs a key of the service account and the subscription's name in its `.env`. It replaces the old instance, it doesn't run next to it: stop the old one first, two instances on one subscription split the conversations between them.

If you don't have the project's id at hand, `gcloud projects list` shows it; then the service account and the subscription:

```bash
PROJECT_ID=<the project's id>
gcloud iam service-accounts list --project="$PROJECT_ID"
gcloud pubsub subscriptions list --project="$PROJECT_ID" --format="value(name)"
```

```bash
SA_EMAIL=<the EMAIL column of the service account Mercury runs as>
SUBSCRIPTION=<the part after subscriptions/>
```

Then, from the new app's folder, create a key, write it into the `.env` with the subscription, and delete the key file:

```bash
gcloud iam service-accounts keys create key.json --iam-account="$SA_EMAIL" --project="$PROJECT_ID"
mfw google-chat set-key key.json --subscription "projects/${PROJECT_ID}/subscriptions/${SUBSCRIPTION}"
rm key.json
```

The old instance's key stays valid until you delete it, and a service account holds at most 10 keys, after which `keys create` fails. List them and delete the ones no instance uses anymore:

```bash
gcloud iam service-accounts keys list --iam-account="$SA_EMAIL" --project="$PROJECT_ID" --managed-by=user
gcloud iam service-accounts keys delete <KEY_ID> --iam-account="$SA_EMAIL" --project="$PROJECT_ID"
```

The key the new app uses is the one with the latest `CREATED_AT`.

Start it and check it as in [step 8](#8-start-and-try-it).

## When the subscription disappears

A subscription created before `--expiration-period=never` was in step 4 still has the default policy, and Pub/Sub deletes it after 31 days without a pull. The channel then logs `NOT_FOUND` on the subscription, while the topic, the service account and the Chat app's configuration are all still there.

Set the variables again first, taking them from the app's `.env`: `GOOGLE_CHAT_PUBSUB_SUBSCRIPTION` is `projects/<PROJECT_ID>/subscriptions/<SUBSCRIPTION>`, and `SA_EMAIL` is `GOOGLE_CHAT_APP_CLIENT_EMAIL`. The topic isn't written anywhere in the app: `gcloud pubsub topics list --project="$PROJECT_ID"` shows it (a project made with these steps has only that one).

```bash
PROJECT_ID=<the part after projects/>
SUBSCRIPTION=<the part after subscriptions/>
SA_EMAIL=<GOOGLE_CHAT_APP_CLIENT_EMAIL>
TOPIC=<the last part of the name the topics list prints>
```

To tell which piece is missing:

```bash
gcloud pubsub topics list --project="$PROJECT_ID"
gcloud pubsub subscriptions list --project="$PROJECT_ID"
```

If only the subscription is gone, recreate it on the same topic and with the same name, so `GOOGLE_CHAT_PUBSUB_SUBSCRIPTION` doesn't change, then give the service account its subscriber role back (it went away with the subscription):

```bash
gcloud pubsub subscriptions create "$SUBSCRIPTION" --topic="$TOPIC" --expiration-period=never --project="$PROJECT_ID"
gcloud pubsub subscriptions add-iam-policy-binding "$SUBSCRIPTION" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/pubsub.subscriber"
```

Then restart the app (`mfw restart`). The messages sent while the subscription was missing are lost, though: Pub/Sub keeps messages only for a subscription that exists.

If the topic is gone too, redo steps 3 to 5 and, in step 7, paste the new topic in **Connection settings**.

To keep a subscription that's still there from expiring:

```bash
gcloud pubsub subscriptions update "$SUBSCRIPTION" --expiration-period=never --project="$PROJECT_ID"
```

MIT
