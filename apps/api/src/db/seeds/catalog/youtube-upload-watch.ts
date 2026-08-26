import { defineSeedProblem } from "../types.js";

export const youtubeUploadWatch = defineSeedProblem({
  slug: "youtube-upload-watch",
  title: "Design YouTube: Upload, Transcode, and Watch",
  difficulty: "hard",
  track: "backend",
  tags: ["storage", "data-pipeline", "cdn", "batch"],
  statement: [
    "Design a user-generated video platform. Anyone can upload a video from a phone or a desktop; anyone else can watch it on any device, at whatever quality their connection supports.",
    "",
    "In scope: resumable upload, the transcode pipeline that produces a multi-quality ladder, the metadata store, the watch path, and view counting.",
    "",
    "Out of scope: recommendations, comments, monetisation, and copyright matching.",
    "",
    "Uploads are wildly heterogeneous: the same queue receives 20-second vertical clips from phones and four-hour 4K uploads from studios. Watch traffic is heavily skewed — a tiny fraction of videos take the overwhelming majority of views, and a video can go from zero to millions of views in an hour."
  ].join("\n"),
  constraints: [
    "An upload must survive a dropped connection and resume from where it stopped, without re-sending bytes already accepted.",
    "A short clip must become watchable within a few minutes even while long uploads are being transcoded — no head-of-line blocking.",
    "Transcoding must be idempotent and resumable: a worker can die mid-job at any point and the job must not corrupt or duplicate output.",
    "View counts may be eventually consistent and approximate, but must never go backwards.",
    "Storage cost is a first-class concern — you are explicitly allowed to not transcode every rung for every video.",
    "The watch path must serve a viral video without its popularity affecting unrelated videos.",
    "Deleting a video must remove it from the watch path within one minute, even if the bytes are purged lazily."
  ],
  narrative: {
    framingScript:
      "We host user-uploaded video. The part that keeps breaking is the middle: someone uploads a four-hour 4K file, it occupies the pipeline, and meanwhile a thousand people who uploaded 30-second clips are staring at 'processing'. I would like you to design the whole path — upload, transcode, watch — but I care most about how work moves through that pipeline. Take it wherever you want to start.",
    signatureChallenge:
      "One queue serves jobs whose cost differs by four orders of magnitude, so any single FIFO pipeline head-of-line blocks. The candidate has to split the work — by segment, by priority class, or both — and then explain how per-segment transcode stays idempotent when a worker dies halfway through a job.",
    progressiveReveals: [
      "Say we are now taking 500 hours of uploaded video every minute, and a third of it is over an hour long.",
      "A transcode worker dies with a job half finished, and the queue redelivers it. What state does the second attempt find, and what does it do?",
      "An uploader says their video has been stuck on 'processing' for six hours. Walk me through how you would find out where it actually is."
    ]
  },
  estimationSpec: {
    intro:
      "Size the pipeline, not just the storage. The interesting number here is how much concurrent transcode capacity the upload rate implies.",
    fields: [
      {
        key: "uploads_per_day",
        label: "Uploads / day",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 100_000,
          max: 50_000_000,
          rationale: "A large UGC platform takes millions of uploads a day, not billions"
        }
      },
      {
        key: "avg_upload_seconds",
        label: "Average video length",
        type: "number",
        unitKind: "seconds",
        displayUnit: "minutes",
        displayMultiplier: 60,
        expectedMagnitude: {
          min: 60,
          max: 6_000,
          rationale: "Short clips pull the mean down; a few minutes is typical"
        }
      },
      {
        key: "avg_source_bytes_per_sec",
        label: "Source bitrate",
        type: "number",
        unitKind: "bytes",
        displayUnit: "MB/s",
        displayMultiplier: 1_048_576,
        hint: "Uploaded masters are far fatter than what you serve",
        expectedMagnitude: {
          min: 500_000,
          max: 50_000_000,
          rationale: "Phone 1080p is a few MB/s; studio 4K is much higher"
        }
      },
      {
        key: "avg_stream_bytes_per_sec",
        label: "Served bitrate (ladder average)",
        type: "number",
        unitKind: "bytes",
        displayUnit: "MB/s",
        displayMultiplier: 1_048_576,
        expectedMagnitude: {
          min: 100_000,
          max: 4_000_000,
          rationale: "Most watch sessions are not on the top rung"
        }
      },
      {
        key: "ladder_rungs",
        label: "Ladder rungs produced per video",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 2,
          max: 40,
          rationale: "Several resolutions across one or two codecs"
        }
      },
      {
        key: "transcode_cpu_ratio",
        label: "Transcode CPU-seconds per second of video, per rung",
        type: "number",
        unitKind: "ratio",
        placeholder: "e.g. 0.5",
        hint: "Below 1 means faster than real time on one core",
        expectedMagnitude: {
          min: 0.05,
          max: 5,
          rationale: "Hardware-accelerated encoding runs faster than real time; software 4K does not"
        }
      },
      {
        key: "views_per_day",
        label: "Video views / day",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 100_000_000,
          max: 100_000_000_000,
          rationale: "Watch traffic dwarfs upload traffic by several orders of magnitude"
        }
      },
      {
        key: "cold_ladder_policy",
        label: "Which rungs do you skip for unpopular videos, and when do you backfill?",
        type: "text"
      }
    ],
    derivedHints: [
      "Compare ingest bytes/day against stored bytes/day. If storage is not several times ingest, your ladder is too small — or you are already skipping rungs, which is a legitimate answer worth saying out loud.",
      "Transcode concurrency is the headline capacity number. If it comes out in the low hundreds of cores, re-check your CPU ratio — 4K software encoding is expensive.",
      "Views per day divided by uploads per day tells you how read-heavy this is, which is the justification for aggressive edge caching."
    ],
    derivedFormulas: [
      {
        id: "ingest_bytes_per_day",
        label: "Ingested bytes / day",
        expression: "uploads_per_day * avg_upload_seconds * avg_source_bytes_per_sec",
        unitKind: "bytes",
        displayUnit: "B/day"
      },
      {
        id: "stored_bytes_per_day",
        label: "Stored bytes / day (all rungs)",
        expression: "uploads_per_day * avg_upload_seconds * ladder_rungs * avg_stream_bytes_per_sec",
        unitKind: "bytes",
        displayUnit: "B/day"
      },
      {
        id: "transcode_concurrency",
        label: "Sustained transcode cores needed",
        expression:
          "uploads_per_day * avg_upload_seconds * ladder_rungs * transcode_cpu_ratio / 86400",
        unitKind: "count",
        displayUnit: "cores"
      },
      {
        id: "watch_egress_per_sec",
        label: "Average watch egress",
        expression: "views_per_day * avg_upload_seconds * avg_stream_bytes_per_sec / 86400",
        unitKind: "bytes",
        displayUnit: "B/s"
      }
    ]
  },
  interviewPlan: {
    intro:
      "Seven phases. Expect to spend the deep dive on the transcode pipeline — that is where this problem is actually hard.",
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 300,
        candidateGuide:
          "Scope it. **Interact with:** **Problem** tab — note which things are explicitly out of scope. **Interviewer** tab — ask me about live streaming, upload size limits, whether you must support every rung for every video, and how fresh view counts need to be. The storage-cost constraint is a hint: ask about it."
      },
      {
        id: "estimate",
        label: "Estimate",
        durationSec: 480,
        candidateGuide:
          "Get to a transcode capacity number. **Interact with:** **Estimation** tab — fill every field and read the derived rows. Say the sustained-cores figure out loud and tell me whether it sounds buildable. **Interviewer** tab — justify your CPU ratio; it is the assumption the whole pipeline sizing rests on."
      },
      {
        id: "upload_path",
        label: "Upload path",
        durationSec: 420,
        candidateGuide:
          "Design resumable ingest. **Interact with:** **Board** — client, upload service, object storage, and the metadata record that tracks progress. **Interviewer** tab — tell me how a client resumes after losing its connection, and what identifies an upload so a retry is not a duplicate. Name the storage primitive you are relying on."
      },
      {
        id: "transcode_pipeline",
        label: "Transcode pipeline",
        durationSec: 780,
        candidateGuide:
          "This is the core. **Interact with:** **Board** — draw how one upload becomes N rungs: segmentation, the queue or queues, worker pools, per-segment output, and the step that publishes a playable manifest. **Interviewer** tab — address head-of-line blocking explicitly, and tell me what a redelivered job sees when the first attempt died halfway. Use **Tutor** for terms like GOP or mezzanine if needed."
      },
      {
        id: "watch_path",
        label: "Watch path",
        durationSec: 480,
        candidateGuide:
          "Serve the video. **Interact with:** **Board** — metadata lookup, manifest, segment delivery, edge caching, and where view events go. **Interviewer** tab — explain how a viral video is served without hurting anything else, and how a delete takes effect in under a minute given everything you are caching."
      },
      {
        id: "deep_dive",
        label: "Deep dive",
        durationSec: 480,
        candidateGuide:
          "Go deep wherever I push. **Interact with:** **Board** — likely candidates are view-count aggregation (approximate, monotonic, and cheap) or the metadata store's partitioning. **Interviewer** tab — expect three or four consecutive follow-ups on one component; stay on it rather than broadening."
      },
      {
        id: "wrap_up",
        label: "Trade-offs and wrap-up",
        durationSec: 360,
        candidateGuide:
          "Close it out. **Interact with:** **Board** — mark the decisions you would revisit, especially any rung you chose not to produce eagerly. **Interviewer** tab — summarise, then answer unprompted: what breaks first at 10x upload volume, and what would you measure to know the pipeline is healthy? Then **Validate**, then **End interview**."
      }
    ]
  },
  rubric: {
    criteria: [
      {
        id: "no_head_of_line_blocking",
        text: "Long uploads cannot delay short ones: work is split or prioritised so a four-hour 4K job does not occupy the pipeline.",
        dimension: "scalability",
        importance: "core",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Per-segment transcode rather than per-file jobs",
          "Separate queues or priority classes by expected job cost"
        ],
        discoveryHints: [
          "What happens to a 30-second clip queued behind a four-hour upload?",
          "What is the unit of work your transcode workers pull?"
        ],
        progressiveNudges: [
          "A four-hour 4K file and a 20-second clip arrive together. Which finishes first?",
          "Is a whole video one job, or many?",
          "One FIFO queue with jobs differing by 10,000x in cost will always head-of-line block. What is your split?"
        ]
      },
      {
        id: "idempotent_resumable_transcode",
        text: "A transcode worker can die mid-job and the redelivered job neither corrupts nor duplicates output.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Deterministic output paths keyed on segment identity",
          "A completion marker checked before work is redone"
        ],
        discoveryHints: [
          "What does a retried job find when the first attempt died halfway?",
          "How do you know a segment is already done?"
        ],
        progressiveNudges: [
          "A worker is killed with a job half complete and the queue redelivers it. What happens?",
          "Does the second attempt know what the first one finished?",
          "Make the write idempotent — what is the key that makes re-running a segment safe?"
        ]
      },
      {
        id: "viral_isolation",
        text: "A single viral video is served without degrading unrelated videos.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Hot content served from edge caches, not from a shared origin path",
          "Per-video or per-tenant limits on shared resources"
        ],
        discoveryHints: [
          "What happens to everything else when one video takes 40% of traffic?",
          "Which resources are shared between videos?"
        ],
        progressiveNudges: [
          "One video goes from zero to ten million views in an hour. What else slows down?",
          "Which component do that video and an unrelated one both contend for?",
          "How do you keep a hot key from consuming a shared partition's capacity?"
        ]
      },
      {
        id: "monotonic_view_counts",
        text: "View counts are aggregated asynchronously and never decrease, despite being approximate.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "staff",
        satisfiedBy: [
          "View events buffered or streamed rather than incrementing a row per view",
          "Aggregation that tolerates retries without double counting or going backwards"
        ],
        discoveryHints: [
          "How is a view recorded, and is that on the watch critical path?",
          "What stops a count going backwards when an aggregator restarts?"
        ],
        progressiveNudges: [
          "Where does a view event go when someone presses play?",
          "Is that a synchronous database increment? What does that cost at your read rate?",
          "Your aggregator restarts and replays a window. How do you avoid a count that jumps or dips?"
        ]
      },
      {
        id: "resumable_upload",
        text: "Uploads survive a dropped connection and resume without re-sending accepted bytes.",
        dimension: "reliability",
        importance: "core",
        satisfiedBy: [
          "Chunked or multipart upload with a server-tracked offset",
          "An upload id the client uses to query progress and continue"
        ]
      },
      {
        id: "publish_visibility",
        text: "A video becomes watchable through an explicit publish step once enough of the ladder exists.",
        dimension: "consistency",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A manifest written only after required rungs complete",
          "A state on the video record distinguishing processing from playable"
        ],
        discoveryHints: [
          "When exactly does a video become playable?",
          "Do all rungs have to finish first?"
        ],
        progressiveNudges: [
          "Three of eight rungs are done. Can a viewer watch yet?",
          "Who flips the switch, and what does it write?",
          "If you publish early, what does a client do when it asks for a rung that does not exist?"
        ]
      },
      {
        id: "transcode_capacity_math",
        text: "Sustained transcode capacity is derived from upload volume, ladder size, and per-rung cost.",
        dimension: "capacityEstimation",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A cores or workers figure computed from upload seconds times rungs times CPU ratio",
          "A stated view on whether that figure is affordable"
        ],
        discoveryHints: [
          "How much compute does a day of uploads need?",
          "What does one rung of one minute of video cost?"
        ],
        progressiveNudges: [
          "Roughly how many hours of video arrive per day?",
          "Multiply by rungs and by encode cost per second of video.",
          "Divide by 86,400 for a sustained core count. Is that number buildable?"
        ]
      },
      {
        id: "delete_propagation",
        text: "A delete removes the video from the watch path within a minute even though bytes are purged lazily.",
        dimension: "consistency",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Authorization or manifest lookup consulted on playback start",
          "Cache invalidation or short-TTL manifests so edges stop serving it"
        ],
        discoveryHints: [
          "What has to happen for a deleted video to stop playing?",
          "What is currently cached that would still serve it?"
        ],
        progressiveNudges: [
          "A creator deletes a video. Can someone still watch it a minute later?",
          "You cached the manifest and the segments at the edge. Which of those must be invalidated?",
          "Purging petabytes takes hours. What makes the video unplayable in the meantime?"
        ]
      },
      {
        id: "storage_tiering_cost",
        text: "Storage cost is managed deliberately, for example by not producing every rung for unpopular videos.",
        dimension: "cost",
        importance: "expected",
        hiddenFrom: "standard",
        satisfiedBy: [
          "A policy tying rung production or storage class to demand",
          "Cold storage or deletion for masters after publish"
        ],
        discoveryHints: [
          "Does every upload deserve the full ladder?",
          "What do you do with the source master after transcoding?"
        ],
        progressiveNudges: [
          "Most uploads are watched almost never. Do they need every rung?",
          "What triggers producing the rest if one becomes popular?",
          "And the original master — do you keep it hot forever?"
        ]
      },
      {
        id: "pipeline_observability",
        text: "A stuck video can be located within the pipeline from recorded per-stage state.",
        dimension: "operability",
        importance: "stretch",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Per-segment or per-stage status persisted and queryable",
          "Queue depth and age metrics per priority class"
        ],
        discoveryHints: [
          "How would you answer a creator asking why their video is still processing?",
          "What state do you record as work moves through?"
        ],
        progressiveNudges: [
          "A video has been processing for six hours. Where is it?",
          "Can you tell which segment or stage it is stuck on, or only that it is unfinished?",
          "What would you record per stage so this question has a one-query answer?"
        ]
      }
    ],
    playbook: {
      areasToProbe: [
        {
          id: "pipeline_shape",
          label: "Transcode pipeline shape",
          phaseRefs: ["transcode_pipeline", "estimate"],
          criterionRefs: [
            "no_head_of_line_blocking",
            "idempotent_resumable_transcode",
            "transcode_capacity_math"
          ],
          sampleQuestions: [
            "A four-hour 4K upload and a 20-second clip arrive together. Which becomes watchable first, and why?",
            "A worker dies with a job half done and the queue redelivers it. What does the retry see?"
          ],
          progressiveNudges: [
            "What is the unit of work a transcode worker pulls?",
            "Is a whole video one job, or is it segmented?",
            "With job costs differing by four orders of magnitude, one queue always blocks. What is your split?"
          ],
          greenFlags: [
            "Segments the video and fans out per-segment work",
            "Names a deterministic output key that makes retries idempotent"
          ],
          redFlags: [
            "One queue, one job per video",
            "Assumes at-most-once delivery from the queue"
          ]
        },
        {
          id: "ingest",
          label: "Resumable ingest",
          phaseRefs: ["upload_path"],
          criterionRefs: ["resumable_upload", "publish_visibility"],
          sampleQuestions: [
            "The uploader's connection drops at 80%. What happens when they retry?",
            "At what exact moment does the video become playable?"
          ],
          progressiveNudges: [
            "How does the client know what the server already has?",
            "What identifies this upload across attempts?",
            "And who marks it publishable — is that all rungs, or some?"
          ],
          greenFlags: [
            "Server-tracked offset queried by the client before resuming",
            "Explicit processing versus playable state on the record"
          ],
          redFlags: ["Single POST of the whole file", "Publishes before any rung exists"]
        },
        {
          id: "read_path",
          label: "Watch path and hot content",
          phaseRefs: ["watch_path", "deep_dive"],
          criterionRefs: ["viral_isolation", "delete_propagation"],
          sampleQuestions: [
            "One video takes 40% of all traffic today. What else gets slower?",
            "A video is deleted. What stops it playing within a minute?"
          ],
          progressiveNudges: [
            "Which components does a hot video share with a cold one?",
            "Where does the hot key actually land?",
            "Now the delete: what is cached that would still serve it, and how is that invalidated?"
          ],
          greenFlags: [
            "Serves hot content from the edge and names the isolation boundary",
            "Distinguishes making it unplayable from purging the bytes"
          ],
          redFlags: [
            "Treats CDN as unlimited without discussing shared partitions",
            "Believes deleting rows makes cached segments unreachable"
          ]
        },
        {
          id: "counting_and_cost",
          label: "View counting and storage cost",
          phaseRefs: ["deep_dive", "wrap_up"],
          criterionRefs: ["monotonic_view_counts", "storage_tiering_cost", "pipeline_observability"],
          sampleQuestions: [
            "How is a view recorded, and what stops the count going backwards after an aggregator restart?",
            "Does a video nobody watches deserve the full encoding ladder?"
          ],
          progressiveNudges: [
            "Is view counting on the watch critical path?",
            "What happens when the aggregator replays a window?",
            "Now cost: which rungs would you defer, and what triggers the backfill?"
          ],
          greenFlags: [
            "Buffers or streams view events off the critical path",
            "Ties rung production to demand with an explicit backfill trigger"
          ],
          redFlags: [
            "Synchronous counter increment per view",
            "Keeps every rung and every master hot forever"
          ]
        }
      ],
      scoreRubric: {
        "1": "Draws upload, transcode, and watch as three boxes with no unit of work, no failure story, and no sense of the cost asymmetry between reads and writes.",
        "2": "Has resumable upload and a queue of transcode jobs, but jobs are per-video, retries are assumed safe, and capacity is not computed.",
        "3": "Segments transcode work, makes it idempotent, avoids head-of-line blocking, computes sustained capacity, and handles hot content on the read path.",
        "4": "Also treats storage as a deliberate cost decision, keeps view counting off the critical path and monotonic, and can locate a stuck video from recorded per-stage state."
      }
    }
  }
});
