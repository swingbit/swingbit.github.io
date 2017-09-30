---
layout: post
title: Plumbing fun with Java and Haskell
date: 2016-02-05
tags: haskell java
---

**Java** is far from perfect, but it is at the very least a safe choice when it comes to be productive on medium/large projects. <img style="float:right; padding:1em" src="https://encrypted-tbn1.gstatic.com/images?q=tbn:ANd9GcSdz4JItBL_U88dmF37j0tcH73xa8dTMOW1mgBYMiYmQNVq_ccR">
So yes. I do use Java in most cases, especially at work. But I still like to have the option to use the right tool for the right job. 

One language I particularly like is **Haskell**. I wish I could say I'm a good Haskell developer, but the truth is that I still shiver when I read "[A monad is just a monoid in the category of endofunctors, what's the problem?](http://stackoverflow.com/questions/3870088/a-monad-is-just-a-monoid-in-the-category-of-endofunctors-whats-the-problem)". In spite of the pain that my code could inflict to true Haskell developers, this is my first choice to implement tree rewriting patterns in DSL transformations, for example in database query optimisation.

Which brings me to this question:

> Can we run Haskell native code from within a Java project, without much pain and runtime overhead?

Perhaps this was very obvious to the rest of the world, but it took me a couple of nights to get it work in practice.

#  An example
We are working on a Java project, and one of its classes looks like this:

**`com/example/FunWithStrings.java`**
``` java
package com.example;

public class FunWithStrings {
  /* How long is the string? */
  public int getLength(String s) {
    return s.length();
  }

  /* I like that string, I want two of them */
  public String twice(String s) {
    return s + s;
  }

  /* Returns all the string's characters, but in alphabetical order */
  public String sort(String s) {
    /* TODO */
  }
}
```

Pretty impressive project, I know.

But what about that `/* TODO */` in the `sort` method? OK, use your imagination here. Pretend that no implementation is available for the sort problem, and let's use Haskell for the job:

``` haskell
qsort :: (Ord a) => [a] -> [a]
qsort []     = []
qsort (x:xs) = qsort ys ++ x : qsort zs where (ys, zs) = partition (< x) xs
```

Yes, that's all the code you need (actually, the function signature in the first line can be inferred automatically by the compiler).

So this is what we would like to do from Java:
``` java
  /* Returns all the string's characters, but in alphabetical order */
  public String sort(String s) {
    return StringUtils.sort(s); /* this calls the Haskell implementation */
  }
```

# Reality check, what are the options?
In principle, there are a number of options to use Haskell code from Java. These are the few I have considered:
- **Compile Haskell to bytecode for the JVM**. This is technically possible, but it seems nobody so far managed to get industrial-strength implementations. See [GHC FAQ](https://wiki.haskell.org/GHC:FAQ#Why_isn.27t_GHC_available_for_.NET_or_on_the_JVM.3F) about this. So not a real option for now.
- **Switch to [Frege](https://github.com/Frege/frege)**, a Haskell implementation that is built to work natively on the JVM. I haven't tried it, but I doubt it can compete with GHC-compiled Haskell code. Also, existing code would need to be adapted a bit.
- **Switch to [Scala](http://www.scala-lang.org/)**, a hybrid object-oriented/functional language that runs natively on the JVM. Scala gained a lot of popularity in recent years and is definitely a good option. However, existing Haskell code would need to be rewritten. Probably a good long-term investment but not my choice for a quick solution.
- **Use a [MessagePack/rpc](http://msgpack.org/) approach**, like [call-haskell-from-anything](https://github.com/nh2/call-haskell-from-anything). This is elegant and flexible, but it obviously introduces overhead.
- **Use [FFI](https://en.wikipedia.org/wiki/Foreign_function_interface) / [JNI](https://en.wikipedia.org/wiki/Java_Native_Interface) interfaces**. 
    - **[java-bridge](http://hackage.haskell.org/package/java-bridge)** FFI package looks like the right tool, but I got the impression that 1) it is only useful to call Java from Haskell (the opposite of what I need here; 2) it is not actively maintained.
    - **[Call Haskell from C via FFI](https://wiki.haskell.org/Calling_Haskell_from_C) and [call C from Java via JNI](http://jonisalonen.com/2012/calling-c-from-java-is-easy/)**. Both steps are proven solid and efficent. Still, it is rather annoying to write the necessary JNI wrappers. This is where [JavaCpp](https://github.com/bytedeco/javacpp) helps. Not only it generates the JNI glueing code, it also makes sure the resulting overhead is minimal.


# The plumbing
<img style="float:right; padding:1em" src="http://media.chicagomag.com//images/2008/May%202008/features_plumbers.jpg?ver=1210266348" width="40%">For my production code, I needed something efficient and relatively simple (not much extra code to implement). I went for the last of the options above. It does need some compilation plumbing, but it gives immediate results without touching the existing code.

These are the steps:
1. Haskell -> C/C++ via FFI
    - compile all needed Haskell code into a binary object (`.o` or `.so`) - called the *native library* from now on. This also generates FFI `.h` interface to use the library from C/C++.
1. C/C++ -> Java via JNI 
    - compile Java calling class that uses javacpp
    - use javacpp builder to generate and compile the JNI code needed to call the native library from Java, packing it into a JNI shared library.
1. archive everything into a jar

We will use the following file structure as a starting point:
```
javacpp.jar
build
  com
    example
      linux-x86_64
src
  StringUtilsFFI.hs
  StringUtils.hs
java
  com
    example
      StringUtils.java
```
The `linux-x86_64` folder is obviously architecture-dependent. This folder will contain the libraries needed at runtime. Intermediate output will instead be stored in `build`.

## 1. Compiling the Haskell code
As we said, Haskell can be called from C/C++ using FFI. Let's see [how to implement the FFI interface](https://wiki.haskell.org/Foreign_Function_Interface):

**`StringUtilsFFI.hs`**
``` haskell
{-# LANGUAGE ForeignFunctionInterface #-}

module StringUtilsFFI where

import Foreign.C.String
import StringUtils

hs_sort :: CString -> IO CString
hs_sort cs = do 
  s <- peekCString cs
  newCString (qsort s)

foreign export ccall hs_sort :: CString -> IO CString
```
Notice the `{-# LANGUAGE ForeignFunctionInterface #-}` pragma, which tells the ghc compiler to generate the FFI wrapping code.

The actual quick sort is implemented here:

**`StringUtils.hs`**
``` haskell
module StringUtils where

import Data.List

qsort :: (Ord a) => [a] -> [a]
qsort []     = []
qsort (x:xs) = qsort ys ++ x : qsort zs where (ys, zs) = partition (< x) xs

```

Compilation:

``` bash
$ ghcVersion=`ghc --version | perl -pe 's/.* ([\d.]+)/$1/'`
$ ghc --make -isrc -outputdir build -dynamic -shared -fPIC
  -lHSrts-ghc${ghcVersion} src/StringUtilsFFI.hs -o build/com/example/linux-x86_64/libStringUtils.so 
```
Unfortunately when linking against the shared version of libHSrts, the ghc run-time system, it is necessary to provide the version number explicitly. However this can be automated as shown in the script.

This produces two files, `build/com/example/linux-x86_64/libStringUtils.so`, which is the native library with our Haskell implementation, and `build/StringUtilsFFI_stub.h`, which is the generated C interface file:

**`build/StringUtilsFFI_stub.h`**
``` c
#include "HsFFI.h"
#ifdef __cplusplus
extern "C" {
#endif
extern HsPtr hs_sort(HsPtr a1);
#ifdef __cplusplus
}
#endif
```

There is an issue here. It seems [the GHC compiler is being a bit lazy](https://ghc.haskell.org/trac/ghc/ticket/10505): `HsPtr` is defined in `HsFFI.h` as `void *`. However, the string argument `a1`, which is our string to be sorted, is expected to be of type `const char *`. 
Until the problem is fixed, we need to patch this file manually:
``` bash
$ perl -p -i -e 's/HsPtr a/const char * a/g' build/StringUtilsFFI_stub.h
```
and obtain:
**`build/StringUtilsFFI_stub.h`**
``` c
#include "HsFFI.h"
#ifdef __cplusplus
extern "C" {
#endif
extern HsPtr hs_sort(const char * a1);
#ifdef __cplusplus
}
#endif
```


# 2. Compiling the Java calling class
Let's create a Java class that implements the wrapping towards the native library:

**`java/com/example/StringUtils.java`**
``` java 
package com.example;
    
import org.bytedeco.javacpp.*;
import org.bytedeco.javacpp.annotation.*;

@Platform(include={"<HsFFI.h>","StringUtilsFFI_stub.h"},
          link="StringUtils",
          preload={ /*HSLIBS*/ })
public class StringUtils  {
    static { Loader.load(); }
    public static native void hs_init(int[] argc, @Cast("char***") @ByPtrPtr PointerPointer argv);
    public static native void hs_exit();
    public static native String hs_sort(String text);

    private static boolean _hsRuntimeInitialized = false;
    
    public static void init() {
        if (!_hsRuntimeInitialized) {
            hs_init(null,null);
            _hsRuntimeInitialized = true;
        }
    }
    
    public static String sort(String s) {
        init();
        String sorted = hs_sort(s);
        return sorted;
    }
    
    public static void unload() {
        if (_hsRuntimeInitialized) {
            hs_exit();
            _hsRuntimeInitialized = false;
        }
    }
		
    /* add a main method for testing */
    public static void main(String[] argv) {
        String s = "";
        for (int i=0 ; i < argv.length ; i++) {
            s = s + argv[i];
        }
        System.out.println(sort(s));
    }
}
```
This class doesn't know anything about Haskell. The FFI interface generated by ghc provides 3 native C functions (the first two by default, the last one because of our `StringUtilsFFI.hs` compilation):
- `hs_init()` initialises the Haskell Runtime system (RTS). It is *mandatory* to call this before one or more calls to `hs_sort()`.
- `hs_exit()` shuts down the RTS.
- `hs_sort()` implements our sort. We make sure that `hs_init()` is called before this, but only once.

Notice that `Loader.load()` is executed within a `static {}` scope. This means it will load the native libraries when the class itself is loaded (unpacking the containing jar to a temporary folder if necessary), so that they will then be ready to executed with no overhead.

We will not compile this class directly, but a copy of it. That's because later on we will extend this step with compile-time modification to this class:

``` bash
$ cp java/com/example/StringUtils.java build/com/example
$ javac -cp javacpp.jar  build/com/example/StringUtils.java
```
This creates `build/com/example/StringUtils.class`, which will be the entrypoint of our jar.

# 3. Generating and compiling the JNI wrapping code
``` bash
$ java -jar javacpp.jar -classpath build 
  -d build/com/example/linux-x86_64
  -Dplatform.compiler=ghc -Dplatform.includepath="build" 
  -Dplatform.compiler.output="-optl-Wl,-rpath,'$ORIGIN' 
  -optc-O3 -Wall -dynamic -fPIC -shared -Lbuild/com/example/linux-x86_64 -o " 
  com.example.StringUtils
```
This creates `build/com/example/linux-x86_64/libjniStringUtils.so`.
*Important*: the `Loader.load()` call expects to find this lib under the location above, starting from the package path `com/...`.

Where will `libjniStringUtils.so` find `libStringUtils.so`? In the same location, thanks to the linker option `-Wl,-rpath,'$ORIGIN'`.

# 4. Archive the result into a jar

``` bash
$ cd build
$ jar cf string-utils.jar 
      com/example/StringUtils.class 
      com/example/linux-x86_64
```

Let's check the content:

``` bash
$ jar tf string-utils.jar
META-INF/
META-INF/MANIFEST.MF
com/example/linux-x86_64/
com/example/linux-x86_64/libjniStringUtils.so
com/example/linux-x86_64/libStringUtils.so
com/example/StringUtils.class
```
Important: `com.example.StringUtils` needs javacpp.jar in the classpath at runtime.

# Great. Is this enough?
Yes it is, but in most cases, it isn't.

## Haskell RTS, is it installed everywhere?
Remember that we have compiled these libraries against the shared version of the Haskell RTS. We can see this by useing `ldd`:
``` bash
$ ldd -d build/com/example/linux-x86_64/libStringUtils.so
        linux-vdso.so.1 (0x00007ffe4dfc0000)
        libHSrts-ghc7.8.4.so => /usr/lib64/ghc-7.8.4/rts-1.0/libHSrts-ghc7.8.4.so (0x00007f43d0d97000)
        libHSbase-4.7.0.2-ghc7.8.4.so => /usr/lib64/ghc-7.8.4/base-4.7.0.2/libHSbase-4.7.0.2-ghc7.8.4.so (0x00007f43cc4f5000)
        libHSinteger-gmp-0.5.1.0-ghc7.8.4.so => /usr/lib64/ghc-7.8.4/integer-gmp-0.5.1.0/libHSinteger-gmp-0.5.1.0-ghc7.8.4.so (0x00007fa6d859d000)
        libHSghc-prim-0.3.1.0-ghc7.8.4.so => /usr/lib64/ghc-7.8.4/ghc-prim-0.3.1.0/libHSghc-prim-0.3.1.0-ghc7.8.4.so (0x00007fa6d8321000)
        librt.so.1 => /lib64/librt.so.1 (0x00007f43cbe29000)
        libutil.so.1 => /lib64/libutil.so.1 (0x00007f43cbc26000)
        libdl.so.2 => /lib64/libdl.so.2 (0x00007f43cba21000)
        libpthread.so.0 => /lib64/libpthread.so.0 (0x00007f43cb805000)
        libgmp.so.10 => /lib64/libgmp.so.10 (0x00007f43cb58d000)
        libc.so.6 => /lib64/libc.so.6 (0x00007f43cb1cc000)
        libm.so.6 => /lib64/libm.so.6 (0x00007f43caec4000)
        libffi.so.6 => /lib64/libffi.so.6 (0x00007f43cacbc000)
        /lib64/ld-linux-x86-64.so.2 (0x0000556d1ae17000)
```

If we take this jar and use it in a different system where the Haskell RTS is not installed, those `libHS*.so` (and all the Haskell libraries that might be used in less trivial code than what we used) won't be found, while it is relatively safe to assume all the other libs are available. 

Well, lets pack them all in the jar. It's sufficient to run this *before* making the jar archive:
``` bash
ldd -d build/com/example/linux-x86_64/libStringUtils.so 
    | grep libHS | perl -pe 's/.*=> ([^(]+) \(.*/$1/' | sort -u 
    | xargs cp -t build/com/example/linux-x86_64
```

Excellent, the jar is now self-contained. Are we there yet? Almost, but not quite.

## Hey, it still can't find the RTS
That's because `libStringUtils.so` was compiled at step 1 without the `-wl,rpath,'$ORIGIN'` option. So our library is still looking for the Haskell RTS in their original locations rather than in the "current" folder. 

Let's change it into:
``` bash
$ ghcVersion=`ghc --version | perl -pe 's/.* ([\d.]+)/$1/'`
$ ghc --make -isrc -outputdir build -dynamic -shared -fPIC
  -lHSrts-ghc${ghcVersion} src/StringUtilsFFI.hs -o build/com/example/linux-x86_64/libStringUtils.so
  -optl-Wl,-rpath,'$ORIGIN'
```

## It still cannot find the RTS!
Indeed, one more step is needed. When `Loader.load()` is called, it unpacks the jar into a temporary folder. However, it doesn't unpack all the content, but only what it has been informed about at compilation time.
Our Java JNI wrapping class contained a javacpp annotation:

**`build/com/example/StringUtils.java`**
``` java 
package com.example;
    
import org.bytedeco.javacpp.*;
import org.bytedeco.javacpp.annotation.*;

@Platform(include={"<HsFFI.h>","StringUtilsFFI_stub.h"},
          link="StringUtils",
          preload={ /*HSLIBS*/ })
public class StringUtils  {
```
We need to extend this annotation with a list of libraries to load (and thus extract):

**`build/com/example/StringUtils.java`**
``` java 
package com.example;
    
import org.bytedeco.javacpp.*;
import org.bytedeco.javacpp.annotation.*;

@Platform(include={"<HsFFI.h>","StringUtilsFFI_stub.h"},
          link="StringUtils",
          preload={"HSrts-ghc7.8.4","HSbase-4.7.0.2-ghc7.8.4", 
                   "HSinteger-gmp-0.5.1.0-ghc7.8.4", "HSghc-prim-0.3.1.0-ghc7.8.4"})
public class StringUtils  {
```

Doing this manually isn't really an option, because you might be using 15-20 libraries in a non-trivial Haskell program. So we need again to automatise this, changing the compilation part of step 2 into:

``` bash
$ cp java/com/example/StringUtils.java build/com/example
$ PRELOADS=`ldd -d build/com/example/linux-x86_64/libStringUtils.so | 
                    grep libHS | perl -pe 's/.*=> ([^(]+) \(.*/$1/' |
                    perl -pe 's/^(.*)$/"$1"/' | sort -u |
                    paste -d, -s`
$ perl -p -i -e "s|\/\*HSLIBS\*\/|${PRELOADS}|" build/com/example/StringUtils.java 
$ javac -cp javacpp.jar  build/com/example/StringUtils.java
```

Yes, this is it, let's put it all together.

# The complete script

We can put everything together into a bash script at the root of our initial structure. In my production code I embed all this in a [Gradle](http://www.gradle.org) script.
``` bash
# init
rm -rf build
mkdir -p build/com/example/linux-x86_64
cp java/com/example/StringUtils.java build/com/example

# Haskell code to native library
ghcVersion=`ghc --version | perl -pe 's/.* ([\d.]+)/$1/'`
ghc --make -isrc -outputdir build -dynamic -shared -fPIC -lHSrts-ghc${ghcVersion} src/StringUtilsFFI.hs -o build/com/example/linux-x86_64/libStringUtils.so
perl -p -i -e 's/HsPtr a/const char * a/g' build/StringUtilsFFI_stub.h

# The java JNI wrapping class
PRELOADS=`ldd -d build/com/example/linux-x86_64/libStringUtils.so | grep libHS | perl -pe 's/.*=> ([^(]+) \(.*/$1/' | perl -pe 's/^(.*)$/"$1"/' | sort -u | paste -d, -s`
perl -p -i -e "s|\/\*HSLIBS\*\/|${PRELOADS}|" build/com/example/StringUtils.java
javac -cp javacpp.jar build/com/example/StringUtils.java

# Tha javacpp JNI glue
java -jar javacpp.jar -classpath build -d build/com/example/linux-x86_64 -Dplatform.compiler=ghc -Dplatform.includepath="build" -Dplatform.compiler.output="-optl-Wl,-rpath,'$ORIGIN' -optc-O3 -Wall -dynamic -fPIC -shared -Lbuild/com/example/linux-x86_64 -o " com.example.StringUtils

# the final jar
cd build ; jar cf string-utils.jar com/example/StringUtils.class com/example/linux-x86_64; cd -
```
## Does it work?

``` bash
$ java -cp javacpp.jar:build/string-utils.jar com.example.StringUtils Yes, it seems to work!
!,Yeeeikmoorsssttw
```
