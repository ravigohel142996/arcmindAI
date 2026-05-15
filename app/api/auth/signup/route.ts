import { db } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcrypt";
import { generateOTP } from "@/lib/otpgenerator";
import { sendMail } from "@/lib/mailer";
import { signUpSchema } from "@/lib/validation/signUpschema";
import { otpEmailTemplate } from "@/components/email-template/otpEmailTemplate";
import {
  httpRequestsTotal,
  httpRequestDurationSeconds,
  apiGatewayErrorsTotal,
  databaseQueryDurationSeconds,
  userLastActivityTimestamp,
  userSignupsTotal,
} from "@/lib/metrics";

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  const route = "/api/auth/signup";
  const method = "POST";
  httpRequestsTotal.inc({ route, method });

  try {
    const body = await req.json();
    const parsedData = signUpSchema.safeParse(body);

    if (!parsedData.success) {
      const errorMessages = parsedData.error;
      apiGatewayErrorsTotal.inc({ status_code: "400" });
      httpRequestDurationSeconds.observe(
        { route },
        (Date.now() - startTime) / 1000,
      );
      return NextResponse.json(
        { success: false, errors: errorMessages },
        { status: 400 },
      );
    }
    const { email, username, password } = parsedData.data;

    if (!email || !username || !password) {
      apiGatewayErrorsTotal.inc({ status_code: "400" });
      httpRequestDurationSeconds.observe(
        { route },
        (Date.now() - startTime) / 1000,
      );
      return NextResponse.json(
        { message: "All fields required" },
        { status: 400 },
      );
    }

    // DEV: When DATABASE_URL is absent, return a mock success response so the
    // signup form can navigate forward. The verify-request page is shown but
    // actual OTP verification is skipped — users can access /generate directly
    // via the dev auth bypass in the protected layout.
    if (process.env.NODE_ENV === "development" && !process.env.DATABASE_URL?.trim()) {
      console.warn("[DEV] DATABASE_URL not set — returning mock signup success.");
      httpRequestDurationSeconds.observe({ route }, (Date.now() - startTime) / 1000);
      return NextResponse.json({
        success: true,
        message: "Dev mode: mock signup. Go to /generate to test the app.",
        user: { id: "local-dev-user", email, username, isVerified: false },
      });
    }

    const dbFindStart = Date.now();
    let existingUser;
    try {
      existingUser = await db.user.findFirst({
        where: {
          email,
        },
      });
    } catch (dbError) {
      console.error(`DB findFirst error for email ${email}:`, dbError);
      throw dbError;
    }
    databaseQueryDurationSeconds.observe(
      { operation: "findFirst" },
      (Date.now() - dbFindStart) / 1000,
    );

    if (existingUser) {
      apiGatewayErrorsTotal.inc({ status_code: "400" });
      httpRequestDurationSeconds.observe(
        { route },
        (Date.now() - startTime) / 1000,
      );
      return NextResponse.json(
        { message: "User already Exist" },
        { status: 400 },
      );
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

    const dbCreateStart = Date.now();
    const user = await db.user.create({
      data: {
        email,
        password: hashedPassword,
        username,
        otp,
        otpExpiry,
        plan: "free",
      },
    });
    databaseQueryDurationSeconds.observe(
      { operation: "create" },
      (Date.now() - dbCreateStart) / 1000,
    );

    // Update user activity
    userLastActivityTimestamp.set({ user_id: user.id }, Date.now() / 1000);

    // Increment user signups
    userSignupsTotal.inc();

    // Send OTP email
    try {
      await sendMail({
        to: email,
        subject: "Verify your email - ArcMindAI",
        html: otpEmailTemplate(otp, username),
      });
    } catch (emailError) {
      console.error(`Failed to send OTP email to ${email}:`, emailError);
      // Optionally, you can choose to fail the signup or continue
      // For now, log and continue, but in production, consider failing
    }

    // Track total HTTP duration
    httpRequestDurationSeconds.observe(
      { route },
      (Date.now() - startTime) / 1000,
    );

    return NextResponse.json({
      success: true,
      message: "User created. Please check your email for verification code.",
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        isVerified: user.isVerified,
      },
    });
  } catch (e) {
    console.error(e);
    apiGatewayErrorsTotal.inc({ status_code: "500" });
    httpRequestDurationSeconds.observe(
      { route },
      (Date.now() - startTime) / 1000,
    );
    return NextResponse.json(
      { message: "Internal Server Error" },
      { status: 500 },
    );
  }
}
