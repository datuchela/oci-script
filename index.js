const core = require("oci-core");
const identity = require("oci-identity");
const common = require("oci-common");
require("dotenv").config();

const AD_REQ_INTERVAL_SECONDS = process.env.AD_REQ_INTERVAL_SECONDS ?? 5;
const RETRY_WAIT_SECONDS = process.env.RETRY_WAIT_SECONDS ?? 64;
const INITIAL_BACKOFF_DELAY_SECONDS =
  process.env.INITIAL_BACKOFF_DELAY_SECONDS ?? 15;
const MAX_BACKOFF_ATTEMPTS = process.env.MAX_BACKOFF_ATTEMPTS ?? 5;

const DISPLAY_NAME = process.env.DISPLAY_NAME ?? "myOciInstance";
const OCI_SHAPE = process.env.OCI_SHAPE ?? "VM.Standard.A1.Flex";
const OCI_OCPUS = process.env.OCI_OCPUS ?? 4;
const OCI_MEMORY_IN_GBS = process.env.OCI_MEMORY_IN_GBS ?? 24;
const OCI_IMAGE_ID = process.env.OCI_IMAGE_ID;
const OCI_COMPARTMENT_ID = process.env.OCI_COMPARTMENT_ID;
const OCI_SUBNET_ID = process.env.OCI_SUBNET_ID;
const SSH_KEY_PUB = process.env.SSH_KEY_PUB;

// Purely for checking purposes
const requiredVars = {
  OCI_IMAGE_ID,
  OCI_COMPARTMENT_ID,
  OCI_SUBNET_ID,
  SSH_KEY_PUB,
};

const optionalVars = {
  AD_REQ_INTERVAL_SECONDS: process.env.AD_REQ_INTERVAL_SECONDS,
  RETRY_WAIT_SECONDS: process.env.RETRY_WAIT_SECONDS,
  LONG_WAIT_MINUTES: process.env.LONG_WAIT_MINUTES,
  INITIAL_BACKOFF_DELAY_SECONDS: process.env.INITIAL_BACKOFF_DELAY_SECONDS,
  DISPLAY_NAME: process.env.DISPLAY_NAME,
  OCI_SHAPE: process.env.OCI_SHAPE,
  OCI_OCPUS: process.env.OCI_OCPUS,
  OCI_MEMORY_IN_GBS: process.env.OCI_MEMORY_IN_GBS,
};

// Load the configuration from the default location (~/.oci/config)
const provider = new common.ConfigFileAuthenticationDetailsProvider();

const identityClient = new identity.IdentityClient({
  authenticationDetailsProvider: provider,
});

const computeClient = new core.ComputeClient({
  authenticationDetailsProvider: provider,
});

const launchInstanceDetailsTemplate = {
  compartmentId: OCI_COMPARTMENT_ID,
  shape: OCI_SHAPE,
  shapeConfig: {
    ocpus: OCI_OCPUS,
    memoryInGBs: OCI_MEMORY_IN_GBS,
  },
  displayName: DISPLAY_NAME,
  sourceDetails: {
    sourceType: "image",
    imageId: OCI_IMAGE_ID,
  },
  createVnicDetails: {
    assignPublicIp: true,
    subnetId: OCI_SUBNET_ID,
  },
  metadata: {
    ssh_authorized_keys: SSH_KEY_PUB,
  },
};

async function createComputeInstance(ad) {
  const launchInstanceDetails = {
    ...launchInstanceDetailsTemplate,
    availabilityDomain: ad.name,
  };

  try {
    const launchInstanceResponse = await computeClient.launchInstance({
      launchInstanceDetails: launchInstanceDetails,
    });

    console.log(
      `Instance created successfully in ${ad.name}:`,
      launchInstanceResponse.instance,
    );
    return "Success";
  } catch (err) {
    const dateString = new Date(Date.now()).toLocaleString();
    if (err.statusCode === 429) {
      console.error(
        `[WARN] ${dateString} - Too many requests in ${ad.name}. Applying backoff strategy...`,
      );
      return "TooManyRequests";
    } else if (err.message === "Out of host capacity.") {
      console.log(`[INFO] ${dateString} - ${ad.name}: Out of host capacity.`);
      return "OutOfHostCapacity";
    } else {
      console.error(
        `[ERROR] ${dateString} - Failed to create instance in ${ad.name}:`,
        err,
      );
      return "Other";
    }
  }
}

async function waitWithTimer(seconds, logFn) {
  return new Promise((resolve) => {
    let timer = 0;

    const interval = setInterval(() => {
      if (timer <= seconds) {
        logFn
          ? logFn(timer)
          : process.stdout.write(
              `Waiting for ${timer}/${seconds} seconds...\r`,
            );
        timer++;
      } else {
        clearInterval(interval);
        process.stdout.write("\n"); // Move to the next line after the timer ends
        resolve();
      }
    }, 1000);
  });
}

async function handleDomain(ad, backOffDelay, backOffMaxAttempts) {
  for (let i = 0; i < backOffMaxAttempts; i++) {
    const result = await createComputeInstance(ad);

    switch (result) {
      case "Success":
        console.log("breaking out of loop...");
        return; // Instance created successfully, exit loop
      case "TooManyRequests":
        const backoffTime = backOffDelay * Math.pow(2, i); // Exponential backoff
        console.log(
          `Waiting for ${backoffTime} seconds before retrying in ${ad.name}`,
        );
        await waitWithTimer(backoffTime, () => {}); // Do not log timer
        break;
      case "OutOfHostCapacity":
        return;
      default:
        return; // Other error, stop retrying
    }
  }
}

async function handleDomainsSequental(availabilityDomains) {
  for (const [_, ad] of availabilityDomains.entries()) {
    console.log(`Sending request to ${ad.name}`);
    handleDomain(ad, INITIAL_BACKOFF_DELAY_SECONDS, MAX_BACKOFF_ATTEMPTS);
    await waitWithTimer(AD_REQ_INTERVAL_SECONDS);
  }
}

async function createComputeInstanceInterval(interval) {
  for (;;) {
    try {
      const listAvailabilityDomainsResponse =
        await identityClient.listAvailabilityDomains({
          compartmentId: OCI_COMPARTMENT_ID,
        });
      const availabilityDomains = listAvailabilityDomainsResponse.items;
      await handleDomainsSequental(availabilityDomains);

      await waitWithTimer(interval);
    } catch (error) {
      console.error("Unhandled error:", error);
    }
  }
}

function checkEnvVariables(vars, optional) {
  console.log(
    `[INFO] Checking ${optional ? "optional" : "required"} environment variables...`,
  );
  for (const [key, value] of Object.entries(vars)) {
    console.log(`${key}=${value}`);
    if (value === null || value === undefined) {
      if (!optional) {
        throw new Error(`${key} is not set in environment variables`);
      }
      console.warn(
        `[WARN] ${key} is not set in environment variables, default value will be used`,
      );
    }
  }
  console.log("[INFO] Done");
}

checkEnvVariables(requiredVars);
checkEnvVariables(optionalVars, true);
createComputeInstanceInterval(RETRY_WAIT_SECONDS);
