# Triggeryze

**[WIP]**

## Make AI generation reactive

Triggeryze watches AI responses as they are generated and executes rules when conditions are met.

A rule can:

* Detect keywords or regex patterns
* Stop generation instantly
* Rewrite paragraphs automatically
* Run background LLM calls
* Generate images
* Execute SillyTavern slash commands
* Create or update lorebook entries
* Publish variables that trigger additional rules

The result is an AI that can react to its own output.

---

## Why Triggeryze exists

Normally, an AI response is just text.

The model writes something.
You read it.
Maybe you edit it.
Maybe you save information manually.
Maybe you generate an image.

With Triggeryze, the response becomes an event stream.

The AI writes something.

Triggeryze notices.

A workflow begins.

---

## Example: Automatic anti-slop editing

Tired of seeing:

* breath hitching
* breath catching
* shaky breaths
* "tell me what you want"
* stone dropped into water metaphors
* repetitive character names

Create a rule:

```text
WHEN:
    regex = breath hitch|breath catch|...

THEN:
    rewrite paragraph
```

The rewrite request launches as soon as the phrase appears.

In many cases the replacement paragraph is already ready before the AI finishes streaming.

Your model keeps writing.

Triggeryze quietly acts as an editor.

---

## Example: Dynamic name replacement

The AI writes:

```text
Elara Voss entered the room.
```

A rule detects the restricted name.

A background LLM receives the surrounding context.

It generates a more appropriate replacement.

The name is rewritten automatically.

No prompt engineering.
No regeneration.
No manual editing.

---

## Example: Scene-aware image generation

The AI writes:

```text
Rain hammered against the tavern windows.
```

Regex detects weather language.

A background LLM analyzes the scene.

It decides:

```text
scene_weather = rain
```

A second rule sees that variable and fires.

An image is generated automatically and attached to the message.

The image wasn't triggered by the word "rain".

It was triggered by an AI interpretation of the scene.

---

## Example: Self-building lorebooks

The AI introduces a new character.

```text
Captain Rowan Ashcroft...
```

Rule 1:

* detect character introduction
* generate profile
* save as `bio`

Rule 2:

* bio exists
* create lorebook entry

Rule 3:

* bio exists
* generate portrait

One paragraph becomes:

* a character profile
* a lorebook entry
* a portrait

all within the same turn.

---

## Self-organizing workflows

Rules do not need explicit wiring.

One rule can publish information.

Another rule can react to it.

Example:

```text
Rule A
-------
Detect weather
Save as: weather

Rule B
-------
weather = rain
Generate image

Rule C
-------
weather = rain
Add ambience note

Rule D
-------
weather = storm
Generate encounter
```

Triggeryze continuously re-evaluates rules as new information appears.

Complex workflows emerge automatically from simple rules.

No node editor.

No flowcharts.

No manual dependency management.

---

## What can it do?

### Real-time generation control

* Stop generation
* Stop and continue generation
* Mid-response lore activation
* Live intervention during streaming

### Automated editing

* Rewrite clichés
* Replace phrases
* Standardize terminology
* Enforce style guides
* Clean up model habits

### AI-powered enrichment

* Run secondary models
* Expand scenes
* Generate descriptions
* Classify content
* Add contextual information

### Dynamic lorebooks

* Read lorebook content in prompts
* Create entries automatically
* Update entries automatically
* Build world information from AI output

### Image workflows

* Generate images from scenes
* Generate portraits from character introductions
* Trigger art from classifications
* Chain image generation into larger workflows

### SillyTavern integration

* Execute slash commands
* Capture command output
* Feed results into later rules
* Combine ST tools with LLM workflows

---

## Core idea

The AI says something.

That becomes an event.

Rules react.

New information is created.

More rules become eligible.

The response evolves while it's being generated.

That's Triggeryze.

---

## Installation

1. Open SillyTavern.
2. Open Extensions.
3. Click Install Extension.
4. Paste the repository URL.
5. Enable Triggeryze.

---

## Documentation

See the [User Guide](docs/user-guide.md) for:

* Triggers
* Actions
* Variables
* Templates
* Profiles
* Lorebook integration
* Workflow design patterns
