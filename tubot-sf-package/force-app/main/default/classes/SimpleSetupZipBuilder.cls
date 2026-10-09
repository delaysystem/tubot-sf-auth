/**
 * @description Minimal stored (uncompressed) ZIP writer for Metadata API
 * deploy payloads. Pure computation with no callouts or DML, so it is fully
 * unit-testable. File names must be ASCII (true for all generated metadata
 * paths). CRC32 uses the standard IEEE polynomial.
 */
public with sharing class SimpleSetupZipBuilder {
    private static final String HEX_DIGITS = '0123456789ABCDEF';
    // 0xEDB88320 as a signed 32-bit integer (Apex has no hex literals).
    private static final Integer CRC_POLY = -306674912;

    private List<String> entryNames = new List<String>();
    private List<String> entryDataHex = new List<String>();

    /** @description Queue one file (zip path using forward slashes). */
    public void addFile(String path, String content) {
        if (String.isBlank(path) || content == null) {
            throw new IllegalArgumentException('ZIP entry path and content are required.');
        }
        entryNames.add(path);
        entryDataHex.add(EncodingUtil.convertToHex(Blob.valueOf(content)));
    }

    /** @description Assemble and return the complete ZIP archive. */
    public Blob build() {
        String localSection = '';
        String centralSection = '';
        Integer offset = 0;
        for (Integer i = 0; i < entryNames.size(); i++) {
            String nameHex = EncodingUtil.convertToHex(Blob.valueOf(entryNames[i]));
            String dataHex = entryDataHex[i];
            Integer dataLen = dataHex.length() / 2;
            Integer nameLen = nameHex.length() / 2;
            Integer crc = crc32FromHex(dataHex);
            localSection += '504B0304' + '1400' + '0000' + '0000' + '0000' + '0021'
                + leHex(crc, 4) + leHex(dataLen, 4) + leHex(dataLen, 4)
                + leHex(nameLen, 2) + '0000' + nameHex + dataHex;
            centralSection += '504B0102' + '1400' + '1400' + '0000' + '0000' + '0000' + '0021'
                + leHex(crc, 4) + leHex(dataLen, 4) + leHex(dataLen, 4)
                + leHex(nameLen, 2) + '0000' + '0000' + '0000' + '0000'
                + leHex(0, 4) + leHex(offset, 4) + nameHex;
            offset += 30 + nameLen + dataLen;
        }
        Integer centralLen = centralSection.length() / 2;
        String endRecord = '504B0506' + '0000' + '0000'
            + leHex(entryNames.size(), 2) + leHex(entryNames.size(), 2)
            + leHex(centralLen, 4) + leHex(offset, 4) + '0000';
        return EncodingUtil.convertFromHex(localSection + centralSection + endRecord);
    }

    /** @description IEEE CRC32 over hex-encoded bytes. */
    public static Integer crc32FromHex(String hexData) {
        Integer crc = -1;
        for (Integer i = 0; i < hexData.length(); i += 2) {
            Integer b = hexToInt(hexData.substring(i, i + 2));
            crc = crc ^ b;
            for (Integer k = 0; k < 8; k++) {
                if ((crc & 1) == 1) {
                    crc = (crc >>> 1) ^ CRC_POLY;
                } else {
                    crc = crc >>> 1;
                }
            }
        }
        return crc ^ -1;
    }

    private static Integer hexToInt(String pair) {
        return HEX_DIGITS.indexOf(pair.substring(0, 1).toUpperCase()) * 16
            + HEX_DIGITS.indexOf(pair.substring(1, 2).toUpperCase());
    }

    private static String leHex(Integer value, Integer byteCount) {
        String hex = '';
        for (Integer i = 0; i < byteCount; i++) {
            Integer b = (value >> (8 * i)) & 255;
            hex += HEX_DIGITS.substring(b >> 4, (b >> 4) + 1)
                + HEX_DIGITS.substring(b & 15, (b & 15) + 1);
        }
        return hex;
    }
}
