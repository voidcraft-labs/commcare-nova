/*
 * Copyright (c) 1998, 2021, Oracle and/or its affiliates. All rights reserved.
 * DO NOT ALTER OR REMOVE COPYRIGHT NOTICES OR THIS FILE HEADER.
 *
 * This code is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License version 2 only, as
 * published by the Free Software Foundation.  Oracle designates this
 * particular file as subject to the "Classpath" exception as provided
 * by Oracle in the LICENSE file that accompanied this code.
 *
 * This code is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
 * version 2 for more details (a copy is included in the LICENSE file that
 * accompanied this code).
 *
 * You should have received a copy of the GNU General Public License version
 * 2 along with this work; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin St, Fifth Floor, Boston, MA 02110-1301 USA.
 *
 * Please contact Oracle, 500 Oracle Parkway, Redwood Shores, CA 94065 USA
 * or visit www.oracle.com if you need additional information or have any
 * questions.
 */

/*
 * Modified by Dimagi, Inc. on 2026-08-25 for the CommCare Nova browser
 * runtime. See MODIFICATIONS.md in the distributed source package.
 */

package org.commcare.nova.xpath.openjdkmath;

/**
 * OpenJDK 17's fdlibm {@code Pow.compute} routine and the bit helpers it uses.
 *
 * <p>TeaVM normally lowers {@link Math#pow(double, double)} to the host
 * JavaScript implementation. ECMAScript permits an implementation-dependent
 * approximation, and V8 has returned adjacent doubles for the same operands
 * on different architectures. JavaRosa calls {@code Math.pow}; this explicit
 * fdlibm path keeps Preview on the pinned OpenJDK 17 result everywhere.
 */
public final class FdLibmPow {
    private static final double INFINITY = Double.POSITIVE_INFINITY;

    private FdLibmPow() {
        throw new UnsupportedOperationException();
    }

    private static int low(double x) {
        return (int) Double.doubleToRawLongBits(x);
    }

    private static double low(double x, int value) {
        long bits = Double.doubleToRawLongBits(x);
        return Double.longBitsToDouble((bits & 0xFFFF_FFFF_0000_0000L)
                | (value & 0x0000_0000_FFFF_FFFFL));
    }

    private static int high(double x) {
        return (int) (Double.doubleToRawLongBits(x) >> 32);
    }

    private static double high(double x, int value) {
        long bits = Double.doubleToRawLongBits(x);
        return Double.longBitsToDouble((bits & 0x0000_0000_FFFF_FFFFL)
                | ((long) value << 32));
    }

    public static double compute(final double x, final double y) {
        double z;
        double r;
        double s;
        double t;
        double u;
        double v;
        double w;
        int i;
        int j;
        int k;
        int n;

        if (y == 0.0) {
            return 1.0;
        }
        if (Double.isNaN(x) || Double.isNaN(y)) {
            return x + y;
        }

        final double yAbs = Math.abs(y);
        double xAbs = Math.abs(x);
        if (y == 2.0) {
            return x * x;
        } else if (y == 0.5) {
            if (x >= -Double.MAX_VALUE) {
                return Math.sqrt(x + 0.0);
            }
        } else if (yAbs == 1.0) {
            return y == 1.0 ? x : 1.0 / x;
        } else if (yAbs == INFINITY) {
            if (xAbs == 1.0) {
                return y - y;
            } else if (xAbs > 1.0) {
                return y >= 0 ? y : 0.0;
            } else {
                return y < 0 ? -y : 0.0;
            }
        }

        final int hx = high(x);
        int ix = hx & 0x7fffffff;
        int yIsInt = 0;
        if (hx < 0) {
            if (yAbs >= 0x1.0p53) {
                yIsInt = 2;
            } else if (yAbs >= 1.0) {
                long yAbsAsLong = (long) yAbs;
                if ((double) yAbsAsLong == yAbs) {
                    yIsInt = 2 - (int) (yAbsAsLong & 0x1L);
                }
            }
        }

        if (xAbs == 0.0 || xAbs == INFINITY || xAbs == 1.0) {
            z = xAbs;
            if (y < 0.0) {
                z = 1.0 / z;
            }
            if (hx < 0) {
                if (((ix - 0x3ff00000) | yIsInt) == 0) {
                    z = (z - z) / (z - z);
                } else if (yIsInt == 1) {
                    z = -z;
                }
            }
            return z;
        }

        n = (hx >> 31) + 1;
        if ((n | yIsInt) == 0) {
            return (x - x) / (x - x);
        }

        s = 1.0;
        if ((n | (yIsInt - 1)) == 0) {
            s = -1.0;
        }

        double pHigh;
        double pLow;
        double t1;
        double t2;
        if (yAbs > 0x1.00000_ffff_ffffp31) {
            final double inverseLog2 = 0x1.7154_7652_b82fep0;
            final double inverseLog2High = 0x1.715476p0;
            final double inverseLog2Low = 0x1.4ae0_bf85_ddf44p-26;

            if (xAbs < 0x1.fffff_0000_0000p-1) {
                return y < 0.0 ? s * INFINITY : s * 0.0;
            }
            if (xAbs > 0x1.00000_ffff_ffffp0) {
                return y > 0.0 ? s * INFINITY : s * 0.0;
            }
            t = xAbs - 1.0;
            w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
            u = inverseLog2High * t;
            v = t * inverseLog2Low - w * inverseLog2;
            t1 = low(u + v, 0);
            t2 = v - (t1 - u);
        } else {
            final double cp = 0x1.ec70_9dc3_a03fdp-1;
            final double cpHigh = 0x1.ec709ep-1;
            final double cpLow = -0x1.e2fe_0145_b01f5p-28;
            final double[] bp = {1.0, 1.5};
            final double[] dpHigh = {0.0, 0x1.2b80_34p-1};
            final double[] dpLow = {0.0, 0x1.cfde_b43c_fd006p-27};
            final double l1 = 0x1.3333_3333_33303p-1;
            final double l2 = 0x1.b6db_6db6_fabffp-2;
            final double l3 = 0x1.5555_5518_f264dp-2;
            final double l4 = 0x1.1746_0a91_d4101p-2;
            final double l5 = 0x1.d864_a93c_9db65p-3;
            final double l6 = 0x1.a7e2_84a4_54eefp-3;

            double zHigh;
            double zLow;
            double ss;
            double s2;
            double sHigh;
            double sLow;
            double tHigh;
            double tLow;
            n = 0;
            if (ix < 0x00100000) {
                xAbs *= 0x1.0p53;
                n -= 53;
                ix = high(xAbs);
            }
            n += (ix >> 20) - 0x3ff;
            j = ix & 0x000fffff;
            ix = j | 0x3ff00000;
            if (j <= 0x3988E) {
                k = 0;
            } else if (j < 0xBB67A) {
                k = 1;
            } else {
                k = 0;
                n += 1;
                ix -= 0x00100000;
            }
            xAbs = high(xAbs, ix);

            u = xAbs - bp[k];
            v = 1.0 / (xAbs + bp[k]);
            ss = u * v;
            sHigh = low(ss, 0);
            tHigh = high(0.0,
                    ((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18));
            tLow = xAbs - (tHigh - bp[k]);
            sLow = v * ((u - sHigh * tHigh) - sHigh * tLow);
            s2 = ss * ss;
            r = s2 * s2 * (l1 + s2 * (l2 + s2 * (l3
                    + s2 * (l4 + s2 * (l5 + s2 * l6)))));
            r += sLow * (sHigh + ss);
            s2 = sHigh * sHigh;
            tHigh = low(3.0 + s2 + r, 0);
            tLow = r - ((tHigh - 3.0) - s2);
            u = sHigh * tHigh;
            v = sLow * tHigh + tLow * ss;
            pHigh = low(u + v, 0);
            pLow = v - (pHigh - u);
            zHigh = cpHigh * pHigh;
            zLow = cpLow * pHigh + pLow * cp + dpLow[k];
            t = n;
            t1 = low(((zHigh + zLow) + dpHigh[k]) + t, 0);
            t2 = zLow - (((t1 - t) - dpHigh[k]) - zHigh);
        }

        double y1 = low(y, 0);
        pLow = (y - y1) * t1 + y * t2;
        pHigh = y1 * t1;
        z = pLow + pHigh;
        j = high(z);
        i = low(z);
        if (j >= 0x40900000) {
            if (((j - 0x40900000) | i) != 0) {
                return s * INFINITY;
            }
            final double overflowThreshold = 8.0085662595372944372e-17;
            if (pLow + overflowThreshold > z - pHigh) {
                return s * INFINITY;
            }
        } else if ((j & 0x7fffffff) >= 0x4090cc00) {
            if (((j - 0xc090cc00) | i) != 0) {
                return s * 0.0;
            }
            if (pLow <= z - pHigh) {
                return s * 0.0;
            }
        }

        final double p1 = 0x1.5555_5555_5553ep-3;
        final double p2 = -0x1.6c16_c16b_ebd93p-9;
        final double p3 = 0x1.1566_aaf2_5de2cp-14;
        final double p4 = -0x1.bbd4_1c5d_26bf1p-20;
        final double p5 = 0x1.6376_972b_ea4d0p-25;
        final double log2 = 0x1.62e4_2fef_a39efp-1;
        final double log2High = 0x1.62e43p-1;
        final double log2Low = -0x1.05c6_10ca_86c39p-29;

        i = j & 0x7fffffff;
        k = (i >> 20) - 0x3ff;
        n = 0;
        if (i > 0x3fe00000) {
            n = j + (0x00100000 >> (k + 1));
            k = ((n & 0x7fffffff) >> 20) - 0x3ff;
            t = high(0.0, n & ~(0x000fffff >> k));
            n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
            if (j < 0) {
                n = -n;
            }
            pHigh -= t;
        }
        t = low(pLow + pHigh, 0);
        u = t * log2High;
        v = (pLow - (t - pHigh)) * log2 + t * log2Low;
        z = u + v;
        w = v - (z - u);
        t = z * z;
        t1 = z - t * (p1 + t * (p2 + t * (p3 + t * (p4 + t * p5))));
        r = (z * t1) / (t1 - 2.0) - (w + z * w);
        z = 1.0 - (r - z);
        j = high(z);
        j += n << 20;
        if ((j >> 20) <= 0) {
            z = Math.scalb(z, n);
        } else {
            z = high(z, high(z) + (n << 20));
        }
        return s * z;
    }
}
