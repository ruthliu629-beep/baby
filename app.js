const fileInputs = {
  a: document.getElementById("photoA"),
  b: document.getElementById("photoB"),
};

const previews = {
  a: document.getElementById("previewA"),
  b: document.getElementById("previewB"),
};

const uploadCards = Array.from(document.querySelectorAll(".upload-card"));
const analyzeBtn = document.getElementById("analyzeBtn");
const generateBtn = document.getElementById("generateBtn");
const demoBtn = document.getElementById("demoBtn");
const copyBtn = document.getElementById("copyBtn");
const resetBtn = document.getElementById("resetBtn");
const genderSelect = document.getElementById("gender");
const modelSelect = document.getElementById("model");
const statusBox = document.getElementById("status");
const jsonOutput = document.getElementById("jsonOutput");
const imageStage = document.getElementById("imageStage");
const imagePlaceholder = document.getElementById("imagePlaceholder");
const babyImage = document.getElementById("babyImage");
const downloadImageLink = document.getElementById("downloadImageLink");
const backendStatus = document.getElementById("backendStatus");
const payPanel = document.getElementById("payPanel");
const payMessage = document.getElementById("payMessage");
const payLink = document.getElementById("payLink");
const copyPayLinkBtn = document.getElementById("copyPayLinkBtn");
const checkPayBtn = document.getElementById("checkPayBtn");
const cancelPayBtn = document.getElementById("cancelPayBtn");

const resultNodes = {
  babyName: document.getElementById("babyNameView"),
  traits: document.getElementById("traitsView"),
  eyes: document.getElementById("eyesView"),
  face: document.getElementById("faceView"),
  hair: document.getElementById("hairView"),
  personality: document.getElementById("personalityView"),
  prompt: document.getElementById("promptView"),
};

const imageStore = {
  a: null,
  b: null,
};

let latestResult = null;
let latestGeneratedImage = "";
let backendKeyReady = false;
let openaiAnalysisReady = false;
let paymentReady = false;
let currentPayment = null;
let paymentPollTimer = null;
let pendingPaidAction = "";

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["babyName", "traits", "eyes", "face", "hair", "personality", "imagePrompt"],
  properties: {
    babyName: {
      type: "string",
      minLength: 1,
      description: "Cute Chinese nickname for the predicted baby.",
    },
    traits: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "string",
        maxLength: 10,
      },
    },
    eyes: {
      type: "string",
      minLength: 1,
    },
    face: {
      type: "string",
      minLength: 1,
    },
    hair: {
      type: "string",
      minLength: 1,
    },
    personality: {
      type: "string",
      minLength: 1,
      description: "Playful vibe label only, purely for entertainment.",
    },
    imagePrompt: {
      type: "string",
      minLength: 1,
    },
  },
};

const systemPrompt = [
  "你是一个「宝宝颜值预测」AI 助手。",
  "你会接收用户上传的一张或两张人像照片，分析双方可见的外貌遗传特征，预测两人孩子的样貌，并输出严格 JSON。",
  "请仔细观察：脸型、眼睛、鼻子、嘴型、肤色、发色、发质、颧骨、下颌线、额头等可见特征。",
  "如果只上传一张照片，也照常输出，并在 babyName 中体现单人推测感，例如类似“小复制版”这种中文昵称风格。",
  "traits 数组必须恰好 4 个条目，每条不超过 10 个汉字，语气积极温暖。",
  "不得输出 JSON 之外的任何内容。",
  "imagePrompt 必须使用英文，具体描述肤色、眼型、发色、脸型等细节，并且结尾固定为：baby ID photo, front-facing, plain white background, centered head and shoulders, gentle natural expression, refined delicate features, clean and pleasing East Asian baby aesthetic, even studio lighting, photorealistic, high quality, 8k。",
  "如果用户指定男宝，就在 imagePrompt 中使用 baby boy；指定女宝就使用 baby girl；未指定就使用 cute baby。",
  "如果图片不够清晰，也要基于可见信息尽力做合理推测，不要拒绝。",
  "不要对照片中人物做负面评价。",
  "personality 字段只给轻松、可爱的娱乐化气质标签，不做真实人格、能力、品行或命运判断。",
].join("\n");

const demoResult = {
  babyName: "小糯团",
  traits: ["大眼软萌", "鼻梁清秀", "脸型圆润", "发量蓬松"],
  eyes: "大概率会是偏圆润的杏眼轮廓，眼神清亮，双眼皮褶皱较柔和，眼距自然，外眼角微微上扬，整体很有灵气。",
  face: "脸型偏圆润鹅蛋脸，面中饱满，下巴小巧，额头弧度柔和，既有立体感又保留明显的宝宝感。",
  hair: "发色接近自然深棕到柔黑之间，发丝细软，发量看起来蓬松，头顶会有一点轻盈的空气感。",
  personality: "奶呼呼活泼型",
  imagePrompt: "cute baby with fair warm-toned skin, bright almond-shaped eyes with soft double eyelids, rounded oval face, gentle small nose bridge, soft rosy lips, fluffy dark brown hair with natural volume, baby ID photo, front-facing, plain white background, centered head and shoulders, gentle natural expression, refined delicate features, clean and pleasing East Asian baby aesthetic, even studio lighting, photorealistic, high quality, 8k",
};

function setStatus(message, tone = "") {
  statusBox.textContent = message;
  statusBox.className = `status ${tone}`.trim();
}

function setBackendStatus(ready, message) {
  backendKeyReady = ready;
  backendStatus.textContent = message;
  backendStatus.className = `backend-status ${ready ? "ready" : "missing"}`.trim();
}

function updatePaymentButtonLabels() {
  if (paymentReady) {
    analyzeBtn.textContent = "支付 0.99 元并生成";
    generateBtn.textContent = "支付 0.99 元重新生成";
    return;
  }

  analyzeBtn.textContent = "开始分析并生成";
  generateBtn.textContent = "重新生成照片";
}

function showPayPanel(message, payUrl = "") {
  payPanel.classList.remove("hidden");
  payMessage.textContent = message;
  payLink.href = payUrl || "#";
  payLink.classList.toggle("hidden", !payUrl);
}

function hidePayPanel() {
  payPanel.classList.add("hidden");
  payMessage.textContent = "订单创建后，这里会显示支付提示。";
  payLink.href = "#";
  payLink.classList.add("hidden");
}

function stopPaymentPolling() {
  if (paymentPollTimer) {
    clearInterval(paymentPollTimer);
    paymentPollTimer = null;
  }
}

function renderResult(result, options = {}) {
  const { cache = true } = options;
  if (cache) {
    latestResult = result;
  }

  resultNodes.babyName.textContent = result.babyName || "未生成";
  resultNodes.eyes.textContent = result.eyes || "等待结果";
  resultNodes.face.textContent = result.face || "等待结果";
  resultNodes.hair.textContent = result.hair || "等待结果";
  resultNodes.personality.textContent = result.personality || "等待结果";
  resultNodes.prompt.textContent = result.imagePrompt || "等待结果";
  resultNodes.traits.innerHTML = "";

  const traits = Array.isArray(result.traits) && result.traits.length
    ? result.traits
    : ["等待结果"];

  traits.forEach((trait) => {
    const pill = document.createElement("span");
    pill.className = `trait-pill ${trait === "等待结果" ? "muted-pill" : ""}`.trim();
    pill.textContent = trait;
    resultNodes.traits.appendChild(pill);
  });

  jsonOutput.textContent = JSON.stringify(result, null, 2);
  updateGenerateAvailability();
}

function resetResult() {
  latestResult = null;
  renderResult({
    babyName: "未生成",
    traits: [],
    eyes: "等待结果",
    face: "等待结果",
    hair: "等待结果",
    personality: "等待结果",
    imagePrompt: "等待结果",
  }, { cache: false });
}

function setImageState(mode, options = {}) {
  imageStage.className = `image-stage ${mode}`.trim();

  if (mode === "ready" && options.src) {
    latestGeneratedImage = options.src;
    imagePlaceholder.innerHTML = "";
    imagePlaceholder.style.display = "none";
    babyImage.src = options.src;
    babyImage.classList.add("visible");
    downloadImageLink.href = options.src;
    downloadImageLink.classList.remove("disabled");
    downloadImageLink.download = `${(latestResult?.babyName || "baby-portrait").replace(/\s+/g, "-")}.jpg`;
    return;
  }

  latestGeneratedImage = "";
  babyImage.src = "";
  babyImage.classList.remove("visible");
  imagePlaceholder.style.display = "flex";
  imagePlaceholder.innerHTML = `<strong>${options.title || "等待生成"}</strong><p>${options.description || "点击“开始分析并生成”后，这里会出现宝宝照片。"}</p>`;
  downloadImageLink.href = "#";
  downloadImageLink.classList.add("disabled");
}

function updateGenerateAvailability() {
  generateBtn.disabled = !latestResult?.imagePrompt;
}

function isLikelyInAppBrowser() {
  const ua = navigator.userAgent || "";
  return /xhs|xiaohongshu|micromessenger|weibo|aweme/i.test(ua);
}

function wireFileInput(key) {
  fileInputs[key].addEventListener("change", async (event) => {
    const [file] = event.target.files || [];
    if (!file) {
      return;
    }

    try {
      await loadImageFile(key, file);
    } catch (error) {
      setStatus(error.message || "图片读取失败，请重试。", "error");
    }
  });
}

async function loadImageFile(key, file) {
  if (!file.type.startsWith("image/")) {
    setStatus("请上传图片文件。", "error");
    return;
  }

  const dataUrl = await readFileAsDataUrl(file);
  const analysis = await sampleImageTraits(dataUrl);
  imageStore[key] = {
    name: file.name,
    dataUrl,
    analysis,
  };

  previews[key].src = dataUrl;
  previews[key].classList.add("visible");
  setStatus("照片已载入，可以开始分析。");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片读取失败，请重试。"));
    reader.readAsDataURL(file);
  });
}

function buildUserPrompt() {
  const gender = genderSelect.value;
  const photoCount = imageStore.a && imageStore.b ? 2 : 1;
  const genderHint = gender ? `用户指定性别：${gender}。` : "用户未指定宝宝性别。";
  return [
    `请基于上传的 ${photoCount} 张照片输出结果。`,
    genderHint,
    "输出语言要求：除 imagePrompt 必须为英文外，其余字段使用自然、温暖的中文。",
    "eyes、face、hair 字段需要写详细描述。",
    "务必只返回 JSON 对象。",
  ].join("\n");
}

function buildApiRequestBody() {
  const content = [
    {
      type: "input_text",
      text: buildUserPrompt(),
    },
  ];

  if (imageStore.a) {
    content.push({
      type: "input_image",
      image_url: imageStore.a.dataUrl,
    });
  }

  if (imageStore.b) {
    content.push({
      type: "input_image",
      image_url: imageStore.b.dataUrl,
    });
  }

  return {
    model: modelSelect.value,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: systemPrompt,
          },
        ],
      },
      {
        role: "user",
        content,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "baby_face_prediction",
        strict: true,
        schema: outputSchema,
      },
    },
  };
}

async function analyzePhotos() {
  if (!imageStore.a && !imageStore.b) {
    setStatus("请先上传至少一张照片。", "error");
    return;
  }

  analyzeBtn.disabled = true;
  generateBtn.disabled = true;
  setImageState("loading", {
    title: "正在分析与出图",
    description: backendKeyReady
      ? "先分析五官特征，再生成宝宝照片。"
      : "先生成分析结果；如果图片服务尚未配置，照片生成会暂停。",
  });
  setStatus("正在分析照片，请稍候...", "busy");

  try {
    let parsed = null;

    if (openaiAnalysisReady) {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          request: buildApiRequestBody(),
        }),
      });

      const payload = await response.json();
      if (response.ok) {
        parsed = extractJsonFromResponse(payload);
        validateResultShape(parsed);
      } else {
        const message = payload?.error?.message || "分析请求失败。";
        if (!shouldUseLocalFallback(message, response.status)) {
          throw new Error(message);
        }
      }
    }

    if (!parsed) {
      parsed = buildLocalPrediction();
    }

    renderResult(parsed);

    if (backendKeyReady) {
      await generateBabyPhoto(parsed);
    } else {
      setImageState("empty", {
        title: "图片服务未配置",
        description: "分析结果已经生成。配置本地图片服务后，这里就能直接生成宝宝照片。",
      });
      setStatus("分析结果已生成；当前还未配置图片服务，所以暂未出图。", "success");
    }
  } catch (error) {
    setImageState("empty", {
      title: "生成失败",
      description: "分析或出图过程中出现问题，请检查本地配置、服务权限或稍后重试。",
    });
    setStatus(error.message || "分析失败，请稍后再试。", "error");
  } finally {
    analyzeBtn.disabled = false;
    updateGenerateAvailability();
  }
}

async function handlePaidAnalyzeClick() {
  if (!imageStore.a && !imageStore.b) {
    setStatus("请先上传至少一张照片。", "error");
    return;
  }

  if (!paymentReady) {
    await analyzePhotos();
    return;
  }

  await startPaymentFlow("analyze");
}

async function handlePaidRegenerateClick() {
  if (!latestResult?.imagePrompt) {
    setStatus("请先生成一次结果后，再重新生成照片。", "error");
    return;
  }

  if (!paymentReady) {
    await generateBabyPhoto();
    return;
  }

  await startPaymentFlow("regenerate");
}

async function startPaymentFlow(action) {
  if (!paymentReady) {
    setStatus("支付功能尚未配置，请先补齐微信支付商户参数。", "error");
    return;
  }

  analyzeBtn.disabled = true;
  generateBtn.disabled = true;
  setStatus("正在创建支付订单，请稍候...", "busy");

  try {
    const response = await fetch("/api/payment/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error?.message || "支付订单创建失败。");
    }

    currentPayment = payload;
    pendingPaidAction = action;

    const inApp = isLikelyInAppBrowser();
    const message = inApp
      ? "请复制支付链接，并在系统浏览器中打开完成微信支付。支付成功后回到这里点“我已支付，刷新状态”。"
      : "请点击“打开支付”完成微信支付。支付成功后页面会自动检查状态。";

    showPayPanel(message, payload.payUrl || "");
    setStatus("支付订单已创建，请先完成支付。", "success");

    if (!inApp && payload.payUrl) {
      window.open(payload.payUrl, "_blank", "noopener,noreferrer");
    }

    stopPaymentPolling();
    paymentPollTimer = window.setInterval(() => {
      void checkPaymentStatus(true);
    }, 3000);
  } catch (error) {
    analyzeBtn.disabled = false;
    updateGenerateAvailability();
    setStatus(error.message || "支付订单创建失败。", "error");
  }
}

async function checkPaymentStatus(silent = false) {
  if (!currentPayment?.orderNo) {
    if (!silent) {
      setStatus("当前没有待支付订单。", "error");
    }
    return;
  }

  try {
    const response = await fetch(`/api/payment/status?out_trade_no=${encodeURIComponent(currentPayment.orderNo)}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error?.message || "支付状态查询失败。");
    }

    if (!payload.paid) {
      if (!silent) {
        setStatus("订单尚未支付成功，请完成支付后再刷新状态。", "busy");
      }
      return;
    }

    stopPaymentPolling();
    hidePayPanel();
    setStatus("支付成功，正在为你生成结果...", "busy");

    const action = pendingPaidAction;
    currentPayment = null;
    pendingPaidAction = "";

    if (action === "regenerate") {
      await generateBabyPhoto();
    } else {
      await analyzePhotos();
    }
  } catch (error) {
    if (!silent) {
      setStatus(error.message || "支付状态查询失败。", "error");
    }
  } finally {
    if (!pendingPaidAction && !paymentPollTimer) {
      analyzeBtn.disabled = false;
      updateGenerateAvailability();
    }
  }
}

async function generateBabyPhoto(result = latestResult) {
  if (!result?.imagePrompt) {
    setStatus("还没有可用于生成图片的 prompt。", "error");
    return;
  }

  if (!backendKeyReady) {
    setImageState("empty", {
      title: "图片服务未配置",
      description: "当前只有分析结果。把图片服务所需密钥写进本地后端私密配置后，点击“重新生成照片”即可出图。",
    });
    setStatus("请先在后端本地完成图片服务配置，再生成宝宝照片。", "error");
    return;
  }

  generateBtn.disabled = true;
  setImageState("loading", {
    title: "正在出图",
    description: "宝宝照片生成通常需要几秒到几十秒，请稍候。",
  });
  setStatus("分析结果已完成，正在根据证件照要求生成宝宝照片...", "busy");

  try {
    const sourceImages = [imageStore.a, imageStore.b]
      .filter(Boolean)
      .map((item) => ({
        name: item.name || "",
        dataUrl: item.dataUrl,
      }));

    const response = await fetch("/api/generate-image", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: buildIdPhotoPrompt(result.imagePrompt),
        babyName: result.babyName || "宝宝",
        sourceImages,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      const message = payload?.error?.message || "图片生成失败，请检查图片服务权限或账号额度。";
      throw new Error(message);
    }

    const imageItem = Array.isArray(payload?.data) ? payload.data[0] : null;
    const base64 = imageItem?.b64_json || "";
    const imageUrl = imageItem?.url || "";
    if (!base64 && !imageUrl) {
      throw new Error("图片接口已返回，但没有拿到图片数据。");
    }

    const src = imageUrl || `data:${inferImageMimeType(base64)};base64,${base64}`;
    setImageState("ready", { src });
    setStatus("宝宝照片已生成，可以继续下载或重新生成。", "success");
  } catch (error) {
    const detail = error?.message || "图片服务返回了生成失败信息。";
    setImageState("empty", {
      title: "生成失败",
      description: detail,
    });
    setStatus(detail, "error");
  } finally {
    updateGenerateAvailability();
  }
}

function extractJsonFromResponse(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return JSON.parse(payload.output_text);
  }

  const output = Array.isArray(payload.output) ? payload.output : [];

  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const chunk of content) {
      if (chunk.type === "output_text" && typeof chunk.text === "string") {
        return JSON.parse(chunk.text);
      }
      if (chunk.type === "json_schema" && chunk.json) {
        return chunk.json;
      }
    }
  }

  throw new Error("接口已返回，但没有拿到可解析的 JSON 内容。");
}

function validateResultShape(result) {
  if (!result || typeof result !== "object") {
    throw new Error("返回结果不是有效 JSON 对象。");
  }

  const requiredFields = ["babyName", "traits", "eyes", "face", "hair", "personality", "imagePrompt"];
  for (const field of requiredFields) {
    if (!(field in result)) {
      throw new Error(`返回 JSON 缺少字段：${field}`);
    }
  }

  if (!Array.isArray(result.traits) || result.traits.length !== 4) {
    throw new Error("traits 必须是恰好包含 4 个条目的数组。");
  }
}

function shouldUseLocalFallback(message, statusCode) {
  const lowered = String(message || "").toLowerCase();
  return (
    statusCode === 429 ||
    lowered.includes("后端未配置 openai api key") ||
    lowered.includes("quota") ||
    lowered.includes("billing") ||
    lowered.includes("insufficient") ||
    lowered.includes("exceeded your current quota")
  );
}

function buildLocalPrediction() {
  const profiles = [imageStore.a, imageStore.b].filter(Boolean).map((item) => item.analysis);
  const merged = mergeProfiles(profiles);
  const gender = genderSelect.value;
  const nicknamePool = gender === "男宝"
    ? ["小满崽", "小栗子", "小团团", "小星仔"]
    : gender === "女宝"
      ? ["小糯米", "小桃桃", "小月牙", "小甜梨"]
      : imageStore.b
        ? ["小圆子", "小奶糖", "小星星", "小团子"]
        : ["小复制版", "小萌团", "小镜像", "小乖宝"];

  const babyName = nicknamePool[Math.floor(Math.random() * nicknamePool.length)];
  const traits = [
    merged.eyeTrait,
    merged.faceTrait,
    merged.hairTrait,
    merged.skinTrait,
  ];

  const subject =
    gender === "男宝" ? "baby boy" : gender === "女宝" ? "baby girl" : "cute baby";
  const genderStyle = getGenderStylePrompt(gender);

  return {
    babyName,
    traits,
    eyes: `${merged.eyeDetail}，整体会带一点清亮、亲和的神情，属于很上镜的宝宝眼型。`,
    face: `${merged.faceDetail}，面部轮廓柔和，脸颊会保留明显的婴儿感和饱满度。`,
    hair: `${merged.hairDetail}，发丝观感偏细软，头顶会有自然蓬松感。`,
    personality: merged.personality,
    imagePrompt: `${subject} with ${merged.skinPrompt}, ${merged.eyePrompt}, ${merged.facePrompt}, ${merged.hairPrompt}, soft tiny nose, rosy lips, ${genderStyle}, baby ID photo, front-facing, plain white background, centered head and shoulders, gentle natural expression, refined delicate features, clean and pleasing East Asian baby aesthetic, even studio lighting, photorealistic, high quality, 8k`,
  };
}

function buildIdPhotoPrompt(basePrompt) {
  const gender = genderSelect.value;
  const genderStyle = getGenderStylePrompt(gender);
  const referenceStyle = getReferencePortraitStylePrompt(gender);
  const suffix = [
    referenceStyle,
    "Haima-style Chinese children studio portrait",
    "premium Chinese child ID portrait style",
    "6 to 8 years old",
    "child portrait instead of baby portrait",
    "front-facing",
    "plain white background",
    "centered composition",
    "head and shoulders only",
    "symmetrical framing",
    "upper chest visible",
    "gentle natural expression",
    "eyes looking at camera",
    "clean studio ID photo",
    "wearing a simple plain white crew-neck top",
    "hair neatly styled",
    "refined delicate features",
    "soft bright skin tone",
    "fair clear porcelain skin",
    "luminous fair skin",
    "clean translucent complexion",
    "bright clear skin with gentle natural whitening",
    "cool fair skin tone",
    "neutral to cool porcelain complexion",
    "clean bright studio skin with minimal warm undertone",
    "clean and pleasing East Asian baby aesthetic",
    "natural soft facial proportions",
    "youthful childlike facial proportions",
    "soft smooth skin retouching",
    "large clear eyes",
    "small refined nose",
    "soft rosy lips",
    "high-end children photo studio finish",
    "cute and neat Chinese-style baby portrait",
    genderStyle,
    "no props",
    "no hat",
    "no toys",
    "no background objects",
    "no exaggerated smile",
    "no messy hair",
    "no artistic background",
    "no text",
    "no watermark",
    "not infant",
    "not toddler",
    "not chubby baby face",
    "photorealistic",
  ].join(", ");

  return `${basePrompt}, ${suffix}`;
}

function getGenderStylePrompt(gender) {
  if (gender === "男宝") {
    return "fresh neat 6 to 8 year old little boy aesthetic, clean short hair, tidy natural fringe, bright spirited eyes, gentle lively expression, slightly more defined eyebrows, tidy and cheerful look, youthful school-age child feeling";
  }

  if (gender === "女宝") {
    return "sweet delicate 6 to 8 year old little girl aesthetic, hair tied up or neatly combed back, soft graceful eyes, gentle lovely expression, softer facial lines, clean and pretty look, youthful school-age child feeling";
  }

  return "soft cute 6 to 8 year old child aesthetic, natural balanced features, gentle and pleasant look, youthful school-age child feeling";
}

function getReferencePortraitStylePrompt(gender) {
  if (gender === "男宝") {
    return "6 to 8 year old East Asian boy portrait, Haima-style children ID photo look, straight-on passport photo look, very clean white studio background, smooth fair skin, naturally enlarged bright eyes, balanced oval face, refined delicate features, short neat black hair, realistic but polished children photography";
  }

  if (gender === "女宝") {
    return "6 to 8 year old East Asian girl portrait, Haima-style children ID photo look, straight-on passport photo look, very clean white studio background, smooth fair skin, naturally enlarged bright eyes, balanced oval face, refined delicate features, dark hair tied into a neat bun or combed back, realistic but polished children photography";
  }

  return "6 to 8 year old East Asian child portrait, Haima-style children ID photo look, straight-on passport photo look, very clean white studio background, smooth fair skin, naturally enlarged bright eyes, balanced oval face, refined delicate features, neat dark hair, realistic but polished children photography";
}

function mergeProfiles(profiles) {
  const defaults = {
    brightness: 150,
    warmth: 12,
    hairBrightness: 70,
  };

  const summary = profiles.length
    ? profiles.reduce(
        (acc, item) => ({
          brightness: acc.brightness + item.brightness,
          warmth: acc.warmth + item.warmth,
          hairBrightness: acc.hairBrightness + item.hairBrightness,
        }),
        { brightness: 0, warmth: 0, hairBrightness: 0 }
      )
    : defaults;

  const divisor = profiles.length || 1;
  const brightness = Math.round(summary.brightness / divisor);
  const warmth = Math.round(summary.warmth / divisor);
  const hairBrightness = Math.round(summary.hairBrightness / divisor);

  const skin = getSkinDescriptors(brightness, warmth);
  const hair = getHairDescriptors(hairBrightness, warmth);
  const eyes = getEyeDescriptors(brightness, warmth, profiles.length);
  const face = getFaceDescriptors(brightness, warmth, profiles.length);
  const personality = getPersonality(brightness, warmth, profiles.length);

  return {
    eyeTrait: eyes.trait,
    faceTrait: face.trait,
    hairTrait: hair.trait,
    skinTrait: skin.trait,
    eyeDetail: eyes.detail,
    faceDetail: face.detail,
    hairDetail: hair.detail,
    personality,
    skinPrompt: skin.prompt,
    eyePrompt: eyes.prompt,
    facePrompt: face.prompt,
    hairPrompt: hair.prompt,
  };
}

function getSkinDescriptors(brightness, warmth) {
  if (brightness >= 178) {
    return {
      trait: "肤感透亮",
      prompt: warmth >= 8 ? "fair warm-toned skin" : "fair neutral skin",
    };
  }

  if (brightness >= 138) {
    return {
      trait: "肤色匀净",
      prompt: warmth >= 8 ? "soft beige warm skin" : "natural ivory skin",
    };
  }

  return {
    trait: "暖调肤感",
    prompt: warmth >= 8 ? "healthy wheat warm skin" : "soft beige skin",
  };
}

function getHairDescriptors(hairBrightness, warmth) {
  if (hairBrightness < 62) {
    return {
      trait: "发色浓密",
      detail: "发色更可能接近自然柔黑或深黑，视觉上会比较浓密顺滑",
      prompt: "soft black fluffy hair",
    };
  }

  if (hairBrightness < 95) {
    return {
      trait: "发丝蓬松",
      detail: "发色大概率落在深棕到柔黑之间，既自然又带一点轻盈层次",
      prompt: warmth >= 8 ? "dark brown fluffy hair" : "deep brown soft hair",
    };
  }

  return {
    trait: "发感轻盈",
    detail: "发色可能偏棕黑或浅一点的自然深棕，整体会显得更轻软",
    prompt: "brown black airy soft hair",
  };
}

function getEyeDescriptors(brightness, warmth, count) {
  if (count === 1) {
    return {
      trait: "眼神清亮",
      detail: "眼睛更像偏圆润的杏眼轮廓，黑白分明，双眼皮褶皱会比较柔和自然",
      prompt: "bright almond-shaped eyes with soft double eyelids",
    };
  }

  if (warmth >= 12) {
    return {
      trait: "杏眼灵动",
      detail: "大概率会形成偏圆杏眼和微微上扬眼角的组合，眼神看起来灵动又温柔",
      prompt: "large bright almond eyes, soft eyelids, gentle uplifted outer corners",
    };
  }

  return {
    trait: "五官秀气",
    detail: "更可能是清秀的杏仁眼或偏细长眼型，眼距自然，神态会显得很安静干净",
    prompt: "clear almond eyes with balanced spacing and delicate eyelids",
  };
}

function getFaceDescriptors(brightness, warmth, count) {
  if (count === 1) {
    return {
      trait: "脸型圆润",
      detail: "脸型会更接近圆润的鹅蛋脸，额头和下巴过渡顺滑，宝宝感很强",
      prompt: "rounded oval face with full cheeks",
    };
  }

  if (brightness >= 165) {
    return {
      trait: "轮廓柔和",
      detail: "整体更像柔和的小鹅蛋脸，颧骨不突兀，下颌线圆顺，气质很甜",
      prompt: "soft oval face, smooth jawline, full baby cheeks",
    };
  }

  return {
    trait: "下巴精致",
    detail: "脸型可能在鹅蛋脸和小圆脸之间，下巴精致紧凑，面中会比较饱满",
    prompt: "compact oval-round face with a small chin and soft cheeks",
  };
}

function getPersonality(brightness, warmth, count) {
  if (count === 1) {
    return warmth >= 10 ? "奶呼呼粘人型" : "安静乖巧型";
  }

  if (brightness >= 170) {
    return "甜萌活泼型";
  }

  if (warmth >= 10) {
    return "温柔亲和型";
  }

  return "文静软萌型";
}

async function sampleImageTraits(dataUrl) {
  const image = await loadImageElement(dataUrl);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return {
      brightness: 150,
      warmth: 10,
      hairBrightness: 75,
    };
  }

  const width = 96;
  const height = Math.max(96, Math.round((image.naturalHeight / image.naturalWidth) * width));

  canvas.width = width;
  canvas.height = height;
  context.drawImage(image, 0, 0, width, height);

  const center = context.getImageData(
    Math.floor(width * 0.25),
    Math.floor(height * 0.24),
    Math.max(24, Math.floor(width * 0.5)),
    Math.max(24, Math.floor(height * 0.46))
  ).data;

  const top = context.getImageData(
    Math.floor(width * 0.2),
    0,
    Math.max(20, Math.floor(width * 0.6)),
    Math.max(18, Math.floor(height * 0.22))
  ).data;

  const centerAvg = averagePixels(center);
  const topAvg = averagePixels(top);

  return {
    brightness: luminance(centerAvg.r, centerAvg.g, centerAvg.b),
    warmth: Math.round(centerAvg.r - centerAvg.b),
    hairBrightness: luminance(topAvg.r, topAvg.g, topAvg.b),
  };
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片解析失败，请换一张试试。"));
    image.src = src;
  });
}

function averagePixels(data) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha < 16) {
      continue;
    }

    r += data[index];
    g += data[index + 1];
    b += data[index + 2];
    count += 1;
  }

  if (!count) {
    return { r: 128, g: 118, b: 110 };
  }

  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
  };
}

function luminance(r, g, b) {
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

function inferImageMimeType(base64) {
  if (typeof base64 !== "string") {
    return "image/jpeg";
  }

  if (base64.startsWith("/9j/")) {
    return "image/jpeg";
  }

  if (base64.startsWith("iVBOR")) {
    return "image/png";
  }

  if (base64.startsWith("UklGR")) {
    return "image/webp";
  }

  return "image/jpeg";
}

async function copyJson() {
  try {
    await navigator.clipboard.writeText(jsonOutput.textContent);
    setStatus("JSON 已复制到剪贴板。", "success");
  } catch (error) {
    setStatus("复制失败，可能是浏览器权限限制。", "error");
  }
}

function resetPage() {
  imageStore.a = null;
  imageStore.b = null;

  Object.values(fileInputs).forEach((input) => {
    input.value = "";
  });

  Object.values(previews).forEach((preview) => {
    preview.src = "";
    preview.classList.remove("visible");
  });

  genderSelect.value = "";
  modelSelect.value = "gpt-4.1-mini";
  latestGeneratedImage = "";
  currentPayment = null;
  pendingPaidAction = "";
  stopPaymentPolling();
  hidePayPanel();
  setImageState("empty", {
    title: "等待生成",
    description: "点击“开始分析并生成”后，这里会出现宝宝照片。",
  });
  resetResult();
  setStatus("已清空，可以重新上传照片。");
}

function attachDragAndDrop() {
  uploadCards.forEach((card, index) => {
    const key = index === 0 ? "a" : "b";

    ["dragenter", "dragover"].forEach((eventName) => {
      card.addEventListener(eventName, (event) => {
        event.preventDefault();
        card.classList.add("drag-over");
      });
    });

    ["dragleave", "drop"].forEach((eventName) => {
      card.addEventListener(eventName, (event) => {
        event.preventDefault();
        if (eventName === "drop") {
          const [file] = event.dataTransfer.files || [];
          if (file) {
            loadImageFile(key, file).catch((error) => {
              setStatus(error.message || "拖拽上传失败。", "error");
            });
          }
        }
        card.classList.remove("drag-over");
      });
    });
  });
}

async function loadBackendStatus() {
  try {
    const response = await fetch("/api/config-status");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error?.message || "无法检查后端配置。");
    }

    openaiAnalysisReady = Boolean(payload?.analysisConfigured);
    paymentReady = Boolean(payload?.paymentConfigured);
    setBackendStatus(Boolean(payload?.imageConfigured), payload?.message || "后端配置状态未知。");
    updatePaymentButtonLabels();
  } catch (error) {
    paymentReady = false;
    setBackendStatus(false, "无法连接后端配置检查接口。");
    updatePaymentButtonLabels();
    setStatus(error.message || "无法检查后端密钥状态。", "error");
  }
}

wireFileInput("a");
wireFileInput("b");
attachDragAndDrop();
analyzeBtn.addEventListener("click", () => {
  void handlePaidAnalyzeClick();
});
generateBtn.addEventListener("click", () => {
  void handlePaidRegenerateClick();
});
demoBtn.addEventListener("click", () => {
  renderResult(demoResult);
  setImageState("empty", {
    title: "示例结果已填充",
    description: "如果想基于这份 prompt 直接出图，填写可用 Key 后点击“重新生成照片”。",
  });
  setStatus("已填充一份示例结果，你可以继续生成示例宝宝图。", "success");
});
copyBtn.addEventListener("click", copyJson);
resetBtn.addEventListener("click", resetPage);
copyPayLinkBtn.addEventListener("click", async () => {
  if (!currentPayment?.payUrl) {
    setStatus("当前没有可复制的支付链接。", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(currentPayment.payUrl);
    setStatus("支付链接已复制，请到系统浏览器打开。", "success");
  } catch (error) {
    setStatus("支付链接复制失败，请手动复制。", "error");
  }
});
checkPayBtn.addEventListener("click", () => {
  void checkPaymentStatus(false);
});
cancelPayBtn.addEventListener("click", () => {
  currentPayment = null;
  pendingPaidAction = "";
  stopPaymentPolling();
  hidePayPanel();
  analyzeBtn.disabled = false;
  updateGenerateAvailability();
  setStatus("已取消本次支付。", "success");
});
loadBackendStatus().catch(() => {});
hidePayPanel();
updatePaymentButtonLabels();
setImageState("empty", {
  title: "等待生成",
  description: "点击“开始分析并生成”后，这里会出现宝宝照片。",
});
resetResult();
