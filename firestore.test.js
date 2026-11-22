const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const { test, before, after, beforeEach } = require("node:test");
const fs = require("node:fs");

let testEnv;
const PROJECT_ID = process.env.GCP_PROJECT || "demo-no-project";
const CUSTOMER_UID = "customer_alice_123";
const KARIGAR_UID = "karigar_bilal_456";
const OTHER_UID = "other_zain_789";

const [emulatorHost, emulatorPortStr] = (
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8085"
).split(":");
const emulatorPort = parseInt(emulatorPortStr, 10);

before(async () => {
  const rules = fs.readFileSync("./firestore.rules", "utf8");
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: emulatorHost,
      port: emulatorPort,
    },
  });
});

after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  if (testEnv) {
    await testEnv.clearFirestore();
  }
});

function pastDate(offsetMs = 5000) {
  return new Date(Date.now() - offsetMs);
}

test("Unauthenticated users cannot read or write any collection", async () => {
  const unauthDb = testEnv.unauthenticatedContext().firestore();
  await assertFails(unauthDb.collection("users").doc(CUSTOMER_UID).get());
  await assertFails(
    unauthDb.collection("karigars").where("active", "==", true).get()
  );
  await assertFails(
    unauthDb.collection("bookings").where("customerId", "==", CUSTOMER_UID).get()
  );
});

test("User profile: owner CRUD works; cross-user PII read/write & ghost fields fail", async () => {
  const customerDb = testEnv.authenticatedContext(CUSTOMER_UID).firestore();
  const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
  const ts = pastDate();

  // Valid create matching Kotlin UserProfile payload
  await assertSucceeds(
    customerDb.collection("users").doc(CUSTOMER_UID).set({
      userId: CUSTOMER_UID,
      displayName: "Ali Khan",
      email: "ali@example.com",
      role: "CUSTOMER",
      phone: "03001234567",
      town: "Gulshan-e-Iqbal",
      address: "Block 13-D, Street 4",
      createdAt: ts,
      updatedAt: ts,
    })
  );

  // Owner read succeeds
  await assertSucceeds(customerDb.collection("users").doc(CUSTOMER_UID).get());

  // Cross-user read & write blocked (PII isolation)
  await assertFails(otherDb.collection("users").doc(CUSTOMER_UID).get());
  await assertFails(
    otherDb.collection("users").doc(CUSTOMER_UID).update({
      phone: "03111111111",
      updatedAt: pastDate(1000),
    })
  );

  // Ghost field & invalid role rejected
  await assertFails(
    customerDb.collection("users").doc(CUSTOMER_UID).update({
      isAdmin: true,
      updatedAt: pastDate(1000),
    })
  );
  await assertFails(
    customerDb.collection("users").doc(CUSTOMER_UID).update({
      role: "ADMIN",
      updatedAt: pastDate(1000),
    })
  );

  // Valid role switch & partial partner profile update on /users/{uid} succeeds
  await assertSucceeds(
    customerDb.collection("users").doc(CUSTOMER_UID).update({
      role: "KARIGAR",
      karigarCategory: "Electrician",
      karigarRate: "Rs. 2500/day",
      karigarActive: true,
      updatedAt: pastDate(1000),
    })
  );

  // Invalid karigarCategory on /users/{uid} rejected
  await assertFails(
    customerDb.collection("users").doc(CUSTOMER_UID).update({
      karigarCategory: "InvalidCategory",
      updatedAt: pastDate(500),
    })
  );
});

test("Karigar directory: owner create/update works; active filter query works; paused karigar hidden; unfiltered list fails", async () => {
  const karigarDb = testEnv.authenticatedContext(KARIGAR_UID).firestore();
  const customerDb = testEnv.authenticatedContext(CUSTOMER_UID).firestore();
  const ts = pastDate();

  // Create karigar profile
  await assertSucceeds(
    karigarDb.collection("karigars").doc(KARIGAR_UID).set({
      ownerId: KARIGAR_UID,
      fullName: "Ustad Bilal",
      category: "Electrician",
      town: "Gulshan-e-Iqbal",
      exactLocation: "Block 13-D, Near Hassan Square",
      phone: "03219876543",
      rate: "Rs. 2500/day",
      active: true,
      createdAt: ts,
      updatedAt: ts,
    })
  );

  // Customer filtered active query succeeds
  await assertSucceeds(
    customerDb
      .collection("karigars")
      .where("active", "==", true)
      .where("category", "==", "Electrician")
      .get()
  );

  // Unfiltered list query fails
  await assertFails(customerDb.collection("karigars").get());

  // Another user cannot hijack or update karigar profile
  await assertFails(
    customerDb.collection("karigars").doc(KARIGAR_UID).update({
      rate: "Rs. 1/day",
      updatedAt: pastDate(1000),
    })
  );

  // Owner pauses listing -> customer single get fails
  await assertSucceeds(
    karigarDb.collection("karigars").doc(KARIGAR_UID).update({
      active: false,
      updatedAt: pastDate(1000),
    })
  );
  await assertFails(customerDb.collection("karigars").doc(KARIGAR_UID).get());
  await assertSucceeds(karigarDb.collection("karigars").doc(KARIGAR_UID).get());
});

test("Bookings: creation checks karigar existence, scoped list queries work, state transitions & terminal lock enforced", async () => {
  const karigarDb = testEnv.authenticatedContext(KARIGAR_UID).firestore();
  const customerDb = testEnv.authenticatedContext(CUSTOMER_UID).firestore();
  const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();
  const ts = pastDate();

  await assertSucceeds(
    karigarDb.collection("karigars").doc(KARIGAR_UID).set({
      ownerId: KARIGAR_UID,
      fullName: "Ustad Bilal",
      category: "AC Technician",
      town: "DHA / Clifton",
      exactLocation: "Phase 5 Khadda Market",
      phone: "03219876543",
      rate: "Rs. 3000/visit",
      active: true,
      createdAt: ts,
      updatedAt: ts,
    })
  );

  const validBooking = {
    customerId: CUSTOMER_UID,
    karigarId: KARIGAR_UID,
    customerName: "Ali Khan",
    customerPhone: "03001234567",
    customerArea: "DHA / Clifton - Phase 6 Lane 2",
    karigarName: "Ustad Bilal",
    karigarCategory: "AC Technician",
    karigarTown: "DHA / Clifton",
    karigarPhone: "03219876543",
    karigarRate: "Rs. 3000/visit",
    details: "Split AC gas refill and service",
    status: "PENDING",
    createdAt: ts,
    updatedAt: ts,
  };

  // Orphaned booking (non-existent karigarId) fails
  await assertFails(
    customerDb
      .collection("bookings")
      .doc("bk_orphan")
      .set({ ...validBooking, karigarId: "non_existent_karigar" })
  );

  // Creating with status ACCEPTED directly fails
  await assertFails(
    customerDb
      .collection("bookings")
      .doc("bk_cheat")
      .set({ ...validBooking, status: "ACCEPTED" })
  );

  // Valid booking create succeeds
  await assertSucceeds(
    customerDb.collection("bookings").doc("bk_1").set(validBooking)
  );

  // Scoped queries succeed for customer and karigar; fail for third party & unfiltered
  await assertSucceeds(
    customerDb.collection("bookings").where("customerId", "==", CUSTOMER_UID).get()
  );
  await assertSucceeds(
    karigarDb.collection("bookings").where("karigarId", "==", KARIGAR_UID).get()
  );
  await assertFails(otherDb.collection("bookings").doc("bk_1").get());
  await assertFails(customerDb.collection("bookings").get());

  // Customer cannot accept own booking
  await assertFails(
    customerDb.collection("bookings").doc("bk_1").update({
      status: "ACCEPTED",
      updatedAt: pastDate(1000),
    })
  );

  // Karigar accepts booking -> completes booking -> terminal state locked
  await assertSucceeds(
    karigarDb.collection("bookings").doc("bk_1").update({
      status: "ACCEPTED",
      updatedAt: pastDate(1000),
    })
  );
  await assertSucceeds(
    karigarDb.collection("bookings").doc("bk_1").update({
      status: "COMPLETED",
      updatedAt: pastDate(500),
    })
  );
  await assertFails(
    karigarDb.collection("bookings").doc("bk_1").update({
      status: "DECLINED",
      updatedAt: pastDate(200),
    })
  );
});
